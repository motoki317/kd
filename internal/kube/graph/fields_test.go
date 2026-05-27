package graph

import (
	"testing"

	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/resource"
)

func TestNodeCapacity(t *testing.T) {
	node := &corev1.Node{Status: corev1.NodeStatus{Allocatable: corev1.ResourceList{
		corev1.ResourceCPU:    resource.MustParse("8"),
		corev1.ResourceMemory: resource.MustParse("16Gi"),
		corev1.ResourcePods:   resource.MustParse("110"),
	}}}
	if got, want := nodeCapacity(node), "8 vCPU · 16Gi · 110 pods"; got != want {
		t.Errorf("nodeCapacity = %q, want %q", got, want)
	}

	if got := nodeCapacity(&corev1.Pod{}); got != "" {
		t.Errorf("nodeCapacity(non-node) = %q, want empty", got)
	}
	if got := nodeCapacity(&corev1.Node{}); got != "" {
		t.Errorf("nodeCapacity(no allocatable) = %q, want empty", got)
	}
}

func TestHumanizeBytes(t *testing.T) {
	tests := map[int64]string{
		512:                     "512B",
		2048:                    "2Ki",
		16 * 1024 * 1024 * 1024: "16Gi",
	}
	for in, want := range tests {
		if got := humanizeBytes(in); got != want {
			t.Errorf("humanizeBytes(%d) = %q, want %q", in, got, want)
		}
	}
}
