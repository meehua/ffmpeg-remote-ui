package queue

import (
	"context"
	"sync"
	"testing"
	"time"
)

func waitFor(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(2 * time.Millisecond)
	}
	t.Fatalf("等待「%s」超时", what)
}

func statusOf(q *Queue, id string) Status {
	j, _ := q.Get(id)
	return j.Status
}

func TestConcurrencyLimit(t *testing.T) {
	var mu sync.Mutex
	running, peak := 0, 0
	release := make(chan struct{})

	runner := func(ctx context.Context, _ *Job, _ *Sink) error {
		mu.Lock()
		running++
		if running > peak {
			peak = running
		}
		mu.Unlock()

		select {
		case <-release:
		case <-ctx.Done():
		}
		mu.Lock()
		running--
		mu.Unlock()
		return nil
	}

	q := New(runner, 2)
	defer q.Close()

	for i := 0; i < 5; i++ {
		if _, err := q.Submit(Job{Input: "in"}); err != nil {
			t.Fatalf("Submit: %v", err)
		}
	}

	waitFor(t, "两个任务同时运行", func() bool {
		mu.Lock()
		defer mu.Unlock()
		return running == 2
	})

	close(release)
	waitFor(t, "全部任务完成", func() bool {
		for _, j := range q.List() {
			if j.Status != StatusDone {
				return false
			}
		}
		return true
	})

	mu.Lock()
	defer mu.Unlock()
	if peak > 2 {
		t.Fatalf("并发数超过上限: peak=%d", peak)
	}
}

func TestQueuePosition(t *testing.T) {
	block := make(chan struct{})
	runner := func(ctx context.Context, _ *Job, _ *Sink) error {
		select {
		case <-block:
		case <-ctx.Done():
		}
		return nil
	}

	q := New(runner, 1)
	defer func() {
		close(block)
		q.Close()
	}()

	first, err := q.Submit(Job{Input: "first"})
	if err != nil {
		t.Fatalf("Submit: %v", err)
	}
	waitFor(t, "首个任务开始运行", func() bool { return statusOf(q, first.ID) == StatusRunning })

	second, _ := q.Submit(Job{Input: "second"})
	third, _ := q.Submit(Job{Input: "third"})

	j2, _ := q.Get(second.ID)
	j3, _ := q.Get(third.ID)
	if j2.Position != 1 || j3.Position != 2 {
		t.Fatalf("排队位置错误: second=%d third=%d，期望 1 和 2", j2.Position, j3.Position)
	}
}

func TestProgressAndLogs(t *testing.T) {
	runner := func(_ context.Context, _ *Job, sink *Sink) error {
		sink.Phase("转码中")
		sink.SetDuration(10 * time.Second)
		sink.Log("输入 #0, h264")
		sink.Log("输出 #0, hevc")
		sink.Progress(Progress{OutTimeMS: 5000, Frame: 120, FPS: 24, Speed: "1.2x"})
		return nil
	}

	q := New(runner, 1)
	defer q.Close()

	job, err := q.Submit(Job{Input: "in"})
	if err != nil {
		t.Fatalf("Submit: %v", err)
	}
	waitFor(t, "任务完成", func() bool { return statusOf(q, job.ID) == StatusDone })

	got, _ := q.Get(job.ID)
	if got.DurationMS != 10000 {
		t.Errorf("DurationMS = %d，期望 10000", got.DurationMS)
	}
	if got.Frame != 120 || got.Speed != "1.2x" {
		t.Errorf("进度字段未沿用: %#v", got)
	}
	// 进度封顶在 99.9，只有真正结束才置 100。
	if got.Progress != 100 {
		t.Errorf("完成后 Progress = %v，期望 100", got.Progress)
	}

	lines := q.Logs(job.ID)
	if len(lines) != 2 || lines[0].Line != "输入 #0, h264" {
		t.Fatalf("日志解析错误: %#v", lines)
	}
	if lines[1].Seq <= lines[0].Seq {
		t.Errorf("日志序号应递增: %#v", lines)
	}
}

func TestProgressCapsBelowHundred(t *testing.T) {
	done := make(chan struct{})
	runner := func(_ context.Context, _ *Job, sink *Sink) error {
		sink.SetDuration(10 * time.Second)
		sink.Progress(Progress{OutTimeMS: 10000})
		close(done)
		// 等测试读到中间态再返回，避免与 finish() 的 100% 竞争。
		time.Sleep(50 * time.Millisecond)
		return nil
	}

	q := New(runner, 1)
	defer q.Close()

	job, _ := q.Submit(Job{Input: "in"})
	<-done

	// 运行中的进度不能是 100，否则界面会先跳到完成态。
	waitFor(t, "读取到中间进度", func() bool {
		j, _ := q.Get(job.ID)
		return j.Status == StatusDone || j.Progress > 0
	})
	j, _ := q.Get(job.ID)
	if j.Status == StatusRunning && j.Progress >= 100 {
		t.Fatalf("运行中的进度不应达到 100: %v", j.Progress)
	}
}

func TestCancelRunningAndQueued(t *testing.T) {
	started := make(chan struct{})
	runner := func(ctx context.Context, _ *Job, _ *Sink) error {
		select {
		case started <- struct{}{}:
		default:
		}
		<-ctx.Done()
		return ctx.Err()
	}

	q := New(runner, 1)
	defer q.Close()

	running, _ := q.Submit(Job{Input: "running"})
	<-started

	queued, _ := q.Submit(Job{Input: "queued"})
	if err := q.Cancel(queued.ID); err != nil {
		t.Fatalf("取消排队任务: %v", err)
	}
	if got := statusOf(q, queued.ID); got != StatusCancelled {
		t.Fatalf("排队任务状态 = %s，期望 cancelled", got)
	}

	if err := q.Cancel(running.ID); err != nil {
		t.Fatalf("取消运行任务: %v", err)
	}
	waitFor(t, "运行任务被取消", func() bool { return statusOf(q, running.ID) == StatusCancelled })
}

func TestRetryAndRemove(t *testing.T) {
	attempts := 0
	runner := func(_ context.Context, _ *Job, _ *Sink) error {
		attempts++
		return nil
	}

	q := New(runner, 1)
	defer q.Close()

	job, _ := q.Submit(Job{Input: "in"})
	waitFor(t, "首次完成", func() bool { return statusOf(q, job.ID) == StatusDone })

	// 尚未结束的任务不允许删除。
	runningJob, _ := q.Submit(Job{Input: "another"})
	waitFor(t, "第二个任务结束", func() bool { return statusOf(q, runningJob.ID) == StatusDone })

	retried, err := q.Retry(job.ID)
	if err != nil {
		t.Fatalf("Retry: %v", err)
	}
	if retried.Attempts != 1 {
		t.Fatalf("重试前 Attempts = %d，期望 1（已执行过一次）", retried.Attempts)
	}
	waitFor(t, "重试完成", func() bool {
		j, _ := q.Get(job.ID)
		return j.Status == StatusDone && j.Attempts == 2
	})

	if err := q.Remove(job.ID); err != nil {
		t.Fatalf("Remove: %v", err)
	}
	if _, ok := q.Get(job.ID); ok {
		t.Error("删除后任务仍然存在")
	}

	if n := q.ClearFinished(); n != 1 {
		t.Errorf("ClearFinished 清理了 %d 项，期望 1", n)
	}
	if list := q.List(); len(list) != 0 {
		t.Errorf("清理后仍有 %d 项", len(list))
	}
}

func TestRunnerPanicDoesNotStallQueue(t *testing.T) {
	runner := func(_ context.Context, job *Job, _ *Sink) error {
		if job.Input == "boom" {
			panic("模拟执行器崩溃")
		}
		return nil
	}

	q := New(runner, 1)
	defer q.Close()

	bad, _ := q.Submit(Job{Input: "boom"})
	waitFor(t, "崩溃任务结束", func() bool { return statusOf(q, bad.ID) == StatusFailed })

	good, _ := q.Submit(Job{Input: "fine"})
	waitFor(t, "后续任务仍能执行", func() bool { return statusOf(q, good.ID) == StatusDone })
}

func TestSubscribeReceivesEvents(t *testing.T) {
	runner := func(_ context.Context, _ *Job, sink *Sink) error {
		sink.Log("hello")
		return nil
	}

	q := New(runner, 1)
	defer q.Close()

	id, ch := q.Subscribe(64)
	defer q.Unsubscribe(id)

	if _, err := q.Submit(Job{Input: "in"}); err != nil {
		t.Fatalf("Submit: %v", err)
	}

	var jobs, logs int
	timeout := time.After(3 * time.Second)
	for jobs == 0 || logs == 0 {
		select {
		case ev, ok := <-ch:
			if !ok {
				t.Fatal("订阅 channel 被意外关闭")
			}
			switch ev.Kind {
			case EventJob:
				jobs++
			case EventLog:
				logs++
			}
		case <-timeout:
			t.Fatalf("事件超时: jobs=%d logs=%d", jobs, logs)
		}
	}
}
