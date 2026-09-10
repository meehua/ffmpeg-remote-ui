package queue

import (
	"context"
	"testing"
)

// 订阅者跟不上时事件会被丢弃，Dropped 必须如实反映出来；
// 否则调用方不会去重同步，客户端就会永久停在过期状态上。
func TestDroppedCountsDiscardedEvents(t *testing.T) {
	q := New(func(context.Context, *Job, *Sink) error { return nil }, 1)
	defer q.Close()

	// 只留 1 个缓冲，并且完全不消费：从第二条事件开始必然被丢弃。
	id, _ := q.Subscribe(1)
	defer q.Unsubscribe(id)

	if got := q.Dropped(); got != 0 {
		t.Fatalf("初始计数 = %d，期望 0", got)
	}

	for i := 0; i < 4; i++ {
		if _, err := q.Submit(Job{Input: "in", Output: "out"}); err != nil {
			t.Fatalf("Submit: %v", err)
		}
	}

	if got := q.Dropped(); got == 0 {
		t.Fatal("订阅者不消费时应当出现丢弃，但计数仍为 0")
	}
}

// 计数是单调的，多个订阅者各自比较自己上次看到的值，不会互相取走标记。
func TestDroppedIsMonotonic(t *testing.T) {
	q := New(func(context.Context, *Job, *Sink) error { return nil }, 1)
	defer q.Close()

	first, _ := q.Subscribe(1)
	defer q.Unsubscribe(first)
	second, _ := q.Subscribe(64) // 缓冲足够，不会丢事件
	defer q.Unsubscribe(second)

	for i := 0; i < 3; i++ {
		if _, err := q.Submit(Job{Input: "in", Output: "out"}); err != nil {
			t.Fatalf("Submit: %v", err)
		}
	}

	before := q.Dropped()
	if before == 0 {
		t.Fatal("缓冲为 1 的订阅者应当造成丢弃")
	}
	if after := q.Dropped(); after < before {
		t.Fatalf("计数应单调不减，得到 %d -> %d", before, after)
	}
}
