// Package queue 提供并发受限的任务调度。
//
// 队列自己不执行任何 FFmpeg：它只负责排队、并发上限、状态流转、进度与
// 日志的汇聚，以及把变化广播给订阅者。真正的执行通过 Runner 注入，
// 因此这个包不依赖 ffmpeg，可以单独测试。
package queue

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"sync"
	"sync/atomic"
	"time"
)

// maxLogLines 限制每个任务保留的日志行数，避免长时间转码把内存吃光。
const maxLogLines = 400

// idSeq 保证同一毫秒内提交的任务也不会撞 ID。
var idSeq atomic.Uint64

func nextID() string {
	return fmt.Sprintf("job-%d-%d", time.Now().UnixMilli(), idSeq.Add(1))
}

type Status string

const (
	StatusQueued    Status = "queued"
	StatusRunning   Status = "running"
	StatusDone      Status = "done"
	StatusFailed    Status = "failed"
	StatusCancelled Status = "cancelled"
)

// Terminal 表示该状态不会再变化。
func (s Status) Terminal() bool {
	return s == StatusDone || s == StatusFailed || s == StatusCancelled
}

// Job 是一个转码任务。
type Job struct {
	ID      string   `json:"id"`
	Label   string   `json:"label,omitempty"`
	Input   string   `json:"input"`
	Output  string   `json:"output"`
	Args    []string `json:"args"`
	Command string   `json:"command"`

	Status   Status  `json:"status"`
	Progress float64 `json:"progress"`        // 0-100
	Phase    string  `json:"phase,omitempty"` // 由执行器上报的阶段说明
	Position int     `json:"position"`        // 排队位置，0 表示不在排队

	DurationMS int64   `json:"durationMs,omitempty"` // 输入总时长
	OutTimeMS  int64   `json:"outTimeMs,omitempty"`  // 已处理时长
	Frame      int64   `json:"frame,omitempty"`
	FPS        float64 `json:"fps,omitempty"`
	Speed      string  `json:"speed,omitempty"`
	Bitrate    string  `json:"bitrate,omitempty"`
	TotalSize  int64   `json:"totalSize,omitempty"`

	Attempts int `json:"attempts"`

	CreatedAt  time.Time  `json:"createdAt"`
	StartedAt  *time.Time `json:"startedAt,omitempty"`
	FinishedAt *time.Time `json:"finishedAt,omitempty"`

	Error string `json:"error,omitempty"`
}

// Progress 是执行器上报的一次进度快照。
type Progress struct {
	OutTimeMS int64   `json:"outTimeMs"`
	Frame     int64   `json:"frame"`
	FPS       float64 `json:"fps"`
	Speed     string  `json:"speed"`
	Bitrate   string  `json:"bitrate"`
	TotalSize int64   `json:"totalSize"`
}

// LogLine 是执行日志里的一行。
type LogLine struct {
	JobID string `json:"jobId"`
	Seq   int64  `json:"seq"`
	Line  string `json:"line"`
}

type EventKind string

const (
	EventJob EventKind = "job"
	EventLog EventKind = "log"
)

// Event 是广播给订阅者的变化。
type Event struct {
	Kind EventKind `json:"kind"`
	Job  *Job      `json:"job,omitempty"`
	Log  *LogLine  `json:"log,omitempty"`
}

// Runner 执行一个任务。
//
// 实现方通过 sink 上报进度与日志，并在 ctx 被取消时尽快返回；
// 返回的 error 会被记入 Job.Error。状态本身由队列负责落定。
type Runner func(ctx context.Context, job *Job, sink *Sink) error

// Sink 是执行器向队列回传信息的出口。
type Sink struct {
	q  *Queue
	id string
}

// Log 追加一行日志。
func (s *Sink) Log(line string) { s.q.appendLog(s.id, line) }

// Progress 上报一次进度。
func (s *Sink) Progress(p Progress) { s.q.applyProgress(s.id, p) }

// Phase 标注当前阶段，例如 "探测输入"。
func (s *Sink) Phase(name string) {
	s.q.mutate(s.id, func(j *Job) { j.Phase = name })
}

// SetDuration 告诉队列输入的总时长，进度百分比据此计算。
func (s *Sink) SetDuration(d time.Duration) {
	ms := d.Milliseconds()
	s.q.mutate(s.id, func(j *Job) { j.DurationMS = ms })
}

type runState struct {
	cancel context.CancelFunc
}

// Queue 是并发受限的任务队列。
type Queue struct {
	runner Runner
	limit  int

	mu      sync.RWMutex
	jobs    map[string]*Job
	order   []string
	pending []string
	running map[string]*runState
	logs    map[string][]LogLine
	logSeq  int64
	closed  bool

	wake chan struct{}
	stop chan struct{}
	done chan struct{}

	subMu   sync.Mutex
	subs    map[int]chan Event
	nextSub int

	// dropped 记录「事件因订阅者跟不上而被丢弃」的累计次数。每个订阅者
	// 各自记住上次看到的数值，据此决定要不要重新对齐。
	dropped atomic.Uint64
}

// New 创建队列并启动调度协程。limit 是同时运行的任务数上限。
func New(runner Runner, limit int) *Queue {
	if limit < 1 {
		limit = 1
	}
	q := &Queue{
		runner:  runner,
		limit:   limit,
		jobs:    map[string]*Job{},
		running: map[string]*runState{},
		logs:    map[string][]LogLine{},
		wake:    make(chan struct{}, 1),
		stop:    make(chan struct{}),
		done:    make(chan struct{}),
		subs:    map[int]chan Event{},
	}
	go q.loop()
	return q
}

// Limit 返回并发上限。
func (q *Queue) Limit() int { return q.limit }

// Dropped 返回「事件因订阅者跟不上而被丢弃」的累计次数。
//
// 用单调计数器而不是一次性的布尔标记：每个订阅者各自记住上次看到的值，
// 于是多个客户端时不会出现「慢的那个被快的那个把标记取走」。
func (q *Queue) Dropped() uint64 { return q.dropped.Load() }

// Submit 入队一个任务。
func (q *Queue) Submit(j Job) (Job, error) {
	q.mu.Lock()
	if q.closed {
		q.mu.Unlock()
		return Job{}, errors.New("队列已关闭")
	}
	if j.ID == "" {
		j.ID = nextID()
	}
	if _, dup := q.jobs[j.ID]; dup {
		q.mu.Unlock()
		return Job{}, fmt.Errorf("任务 ID 重复: %s", j.ID)
	}
	j.Status = StatusQueued
	j.Progress = 0
	j.Position = 0
	j.Attempts = 0
	j.CreatedAt = time.Now()
	job := &j
	q.jobs[j.ID] = job
	q.order = append(q.order, j.ID)
	q.pending = append(q.pending, j.ID)
	q.refreshPositionsLocked()
	out := *job
	q.mu.Unlock()

	q.broadcast(Event{Kind: EventJob, Job: &out})
	q.notify()
	return out, nil
}

// Get 返回单个任务。
func (q *Queue) Get(id string) (Job, bool) {
	q.mu.RLock()
	defer q.mu.RUnlock()
	j, ok := q.jobs[id]
	if !ok {
		return Job{}, false
	}
	return *j, true
}

// List 返回全部任务，最新的排在前面。
func (q *Queue) List() []Job {
	q.mu.RLock()
	out := make([]Job, 0, len(q.order))
	for _, id := range q.order {
		if j := q.jobs[id]; j != nil {
			out = append(out, *j)
		}
	}
	q.mu.RUnlock()

	sort.SliceStable(out, func(i, k int) bool { return out[i].CreatedAt.After(out[k].CreatedAt) })
	return out
}

// Logs 返回某个任务保留的日志。
func (q *Queue) Logs(id string) []LogLine {
	q.mu.RLock()
	defer q.mu.RUnlock()
	out := make([]LogLine, len(q.logs[id]))
	copy(out, q.logs[id])
	return out
}

// Cancel 取消排队中或运行中的任务。
func (q *Queue) Cancel(id string) error {
	q.mu.Lock()
	j := q.jobs[id]
	if j == nil {
		q.mu.Unlock()
		return errors.New("任务不存在")
	}
	switch j.Status {
	case StatusRunning:
		st := q.running[id]
		q.mu.Unlock()
		if st != nil {
			st.cancel()
		}
		return nil
	case StatusQueued:
		q.pending = removeString(q.pending, id)
		now := time.Now()
		j.Status = StatusCancelled
		j.FinishedAt = &now
		j.Error = "已取消"
		j.Position = 0
		q.refreshPositionsLocked()
		out := *j
		q.mu.Unlock()
		q.broadcast(Event{Kind: EventJob, Job: &out})
		return nil
	default:
		status := j.Status
		q.mu.Unlock()
		return fmt.Errorf("任务已结束（%s）", status)
	}
}

// Retry 把已结束的任务重新排队，保留原来的参数。
func (q *Queue) Retry(id string) (Job, error) {
	q.mu.Lock()
	j := q.jobs[id]
	if j == nil {
		q.mu.Unlock()
		return Job{}, errors.New("任务不存在")
	}
	if !j.Status.Terminal() {
		q.mu.Unlock()
		return Job{}, errors.New("任务尚未结束")
	}
	j.Status = StatusQueued
	j.Progress = 0
	j.Phase = ""
	j.Error = ""
	j.Position = 0
	j.OutTimeMS, j.Frame, j.FPS, j.TotalSize = 0, 0, 0, 0
	j.Speed, j.Bitrate = "", ""
	j.StartedAt, j.FinishedAt = nil, nil
	q.logs[id] = nil
	q.pending = append(q.pending, id)
	q.refreshPositionsLocked()
	out := *j
	q.mu.Unlock()

	q.broadcast(Event{Kind: EventJob, Job: &out})
	q.notify()
	return out, nil
}

// Remove 删除一个已结束的任务。
func (q *Queue) Remove(id string) error {
	q.mu.Lock()
	defer q.mu.Unlock()
	j := q.jobs[id]
	if j == nil {
		return errors.New("任务不存在")
	}
	if !j.Status.Terminal() {
		return errors.New("任务仍在队列中，请先取消")
	}
	delete(q.jobs, id)
	delete(q.logs, id)
	q.order = removeString(q.order, id)
	return nil
}

// ClearFinished 清空所有已结束的任务，返回删除数量。
func (q *Queue) ClearFinished() int {
	q.mu.Lock()
	defer q.mu.Unlock()
	removed := 0
	for _, id := range append([]string(nil), q.order...) {
		if j := q.jobs[id]; j != nil && j.Status.Terminal() {
			delete(q.jobs, id)
			delete(q.logs, id)
			q.order = removeString(q.order, id)
			removed++
		}
	}
	return removed
}

// Subscribe 订阅变化；返回的 channel 只会在事件到达或队列关闭时收到值。
func (q *Queue) Subscribe(buffer int) (int, <-chan Event) {
	if buffer < 1 {
		buffer = 1
	}
	ch := make(chan Event, buffer)
	q.subMu.Lock()
	id := q.nextSub
	q.nextSub++
	q.subs[id] = ch
	q.subMu.Unlock()
	return id, ch
}

// Unsubscribe 取消订阅并关闭对应的 channel。
func (q *Queue) Unsubscribe(id int) {
	q.subMu.Lock()
	ch, ok := q.subs[id]
	delete(q.subs, id)
	q.subMu.Unlock()
	if ok {
		close(ch)
	}
}

// Close 停止调度并取消所有运行中的任务。
func (q *Queue) Close() {
	q.mu.Lock()
	if q.closed {
		q.mu.Unlock()
		return
	}
	q.closed = true
	for _, st := range q.running {
		st.cancel()
	}
	q.mu.Unlock()

	close(q.stop)
	<-q.done
}

// ---------------------------------------------------------------- 调度

func (q *Queue) loop() {
	defer close(q.done)
	for {
		select {
		case <-q.stop:
			return
		case <-q.wake:
		}
		q.dispatch()
	}
}

// dispatch 在有空闲槽位时尽可能多地启动任务。
func (q *Queue) dispatch() {
	for {
		q.mu.Lock()
		if q.closed || len(q.running) >= q.limit || len(q.pending) == 0 {
			q.mu.Unlock()
			return
		}
		id := q.pending[0]
		q.pending = q.pending[1:]
		job := q.jobs[id]
		if job == nil || job.Status != StatusQueued {
			q.mu.Unlock()
			continue
		}

		ctx, cancel := context.WithCancel(context.Background())
		q.running[id] = &runState{cancel: cancel}
		now := time.Now()
		job.Status = StatusRunning
		job.StartedAt = &now
		job.FinishedAt = nil
		job.Position = 0
		job.Attempts++
		q.refreshPositionsLocked()
		out := *job
		q.mu.Unlock()

		q.broadcast(Event{Kind: EventJob, Job: &out})
		go q.execute(ctx, id)
	}
}

// execute 运行一个任务并负责收尾；即使 Runner 崩溃也不会卡住队列。
func (q *Queue) execute(ctx context.Context, id string) {
	var err error
	defer func() {
		if r := recover(); r != nil {
			err = fmt.Errorf("任务执行器内部错误: %v", r)
		}
		q.finish(ctx, id, err)
	}()

	q.mu.RLock()
	job, ok := q.jobs[id]
	var copy *Job
	if ok {
		c := *job
		copy = &c
	}
	q.mu.RUnlock()
	if copy == nil {
		return
	}

	sink := &Sink{q: q, id: id}
	err = q.runner(ctx, copy, sink)
}

func (q *Queue) finish(ctx context.Context, id string, err error) {
	q.mu.Lock()
	// 先判定结果，再释放 context：cancel() 之后 ctx.Err() 会立刻变成非 nil，
	// 如果先调用它，正常完成的任务也会被误判为已取消。
	cancelled := ctx.Err() != nil
	j := q.jobs[id]
	if j != nil && !j.Status.Terminal() {
		now := time.Now()
		j.FinishedAt = &now
		switch {
		case cancelled:
			j.Status = StatusCancelled
			if j.Error == "" {
				j.Error = "已取消"
			}
		case err != nil:
			j.Status = StatusFailed
			j.Error = err.Error()
		default:
			j.Status = StatusDone
			j.Progress = 100
		}
	}
	if st, ok := q.running[id]; ok {
		st.cancel()
		delete(q.running, id)
	}
	var out *Job
	if j != nil {
		c := *j
		out = &c
	}
	q.mu.Unlock()

	if out != nil {
		q.broadcast(Event{Kind: EventJob, Job: out})
	}
	q.notify()
}

func (q *Queue) notify() {
	select {
	case q.wake <- struct{}{}:
	default: // 已经有人叫醒了调度器
	}
}

// ---------------------------------------------------------------- 状态更新

func (q *Queue) mutate(id string, fn func(*Job)) {
	q.mu.Lock()
	j := q.jobs[id]
	if j == nil {
		q.mu.Unlock()
		return
	}
	fn(j)
	out := *j
	q.mu.Unlock()
	q.broadcast(Event{Kind: EventJob, Job: &out})
}

func (q *Queue) applyProgress(id string, p Progress) {
	q.mu.Lock()
	j := q.jobs[id]
	if j == nil || j.Status != StatusRunning {
		q.mu.Unlock()
		return
	}
	if p.OutTimeMS > 0 {
		j.OutTimeMS = p.OutTimeMS
	}
	if p.Frame > 0 {
		j.Frame = p.Frame
	}
	if p.FPS > 0 {
		j.FPS = p.FPS
	}
	if p.Speed != "" && p.Speed != "N/A" {
		j.Speed = p.Speed
	}
	if p.Bitrate != "" && p.Bitrate != "N/A" {
		j.Bitrate = p.Bitrate
	}
	if p.TotalSize > 0 {
		j.TotalSize = p.TotalSize
	}
	// 只在能算出百分比时推进，且把 100% 留给真正结束的那一刻。
	if j.DurationMS > 0 && j.OutTimeMS > 0 {
		pct := float64(j.OutTimeMS) / float64(j.DurationMS) * 100
		if pct > 99.9 {
			pct = 99.9
		}
		if pct > j.Progress {
			j.Progress = pct
		}
	}
	out := *j
	q.mu.Unlock()
	q.broadcast(Event{Kind: EventJob, Job: &out})
}

func (q *Queue) appendLog(id, line string) {
	q.mu.Lock()
	if _, ok := q.jobs[id]; !ok {
		q.mu.Unlock()
		return
	}
	q.logSeq++
	l := LogLine{JobID: id, Seq: q.logSeq, Line: line}
	buf := append(q.logs[id], l)
	if len(buf) > maxLogLines {
		buf = buf[len(buf)-maxLogLines:]
	}
	q.logs[id] = buf
	q.mu.Unlock()

	q.broadcast(Event{Kind: EventLog, Log: &l})
}

// refreshPositionsLocked 重算排队位置；调用方需持有写锁。
func (q *Queue) refreshPositionsLocked() {
	for i, id := range q.pending {
		if j := q.jobs[id]; j != nil {
			j.Position = i + 1
		}
	}
}

func (q *Queue) broadcast(e Event) {
	q.subMu.Lock()
	defer q.subMu.Unlock()
	for _, ch := range q.subs {
		select {
		case ch <- e:
		default:
			// 订阅者消费不过来时丢弃这一条并累计计数：调用方会在下一次心跳
			// 时补一份全量快照，避免它永久停在过期状态上。
			q.dropped.Add(1)
		}
	}
}

func removeString(list []string, target string) []string {
	for i, v := range list {
		if v == target {
			return append(list[:i:i], list[i+1:]...)
		}
	}
	return list
}
