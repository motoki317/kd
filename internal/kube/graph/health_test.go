package graph

import (
	"testing"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

func TestPodStatusSummary(t *testing.T) {
	waiting := func(reason string) corev1.Pod {
		return corev1.Pod{Status: corev1.PodStatus{
			Phase:             corev1.PodRunning,
			ContainerStatuses: []corev1.ContainerStatus{{State: corev1.ContainerState{Waiting: &corev1.ContainerStateWaiting{Reason: reason}}}},
		}}
	}

	tests := map[string]struct {
		pod  corev1.Pod
		want string
	}{
		"running falls back to phase": {
			pod:  corev1.Pod{Status: corev1.PodStatus{Phase: corev1.PodRunning}},
			want: "Running",
		},
		"running with all containers ready stays Running": {
			pod: corev1.Pod{Status: corev1.PodStatus{
				Phase:             corev1.PodRunning,
				ContainerStatuses: []corev1.ContainerStatus{{Ready: true}, {Ready: true}},
			}},
			want: "Running",
		},
		"running with a not-ready container shows ready/total": {
			pod: corev1.Pod{Status: corev1.PodStatus{
				Phase:             corev1.PodRunning,
				ContainerStatuses: []corev1.ContainerStatus{{Ready: true}, {Ready: false}},
			}},
			want: "Running 1/2",
		},
		"pending falls back to phase": {
			pod:  corev1.Pod{Status: corev1.PodStatus{Phase: corev1.PodPending}},
			want: "Pending",
		},
		"crash-looping container shows its reason, not Running": {
			pod:  waiting("CrashLoopBackOff"),
			want: "CrashLoopBackOff",
		},
		"image pull failure shows its reason": {
			pod:  waiting("ImagePullBackOff"),
			want: "ImagePullBackOff",
		},
		"terminated with error shows the reason": {
			pod: corev1.Pod{Status: corev1.PodStatus{
				Phase:             corev1.PodRunning,
				ContainerStatuses: []corev1.ContainerStatus{{State: corev1.ContainerState{Terminated: &corev1.ContainerStateTerminated{Reason: "OOMKilled"}}}},
			}},
			want: "OOMKilled",
		},
		"completed terminated container is not treated as an error": {
			pod: corev1.Pod{Status: corev1.PodStatus{
				Phase:             corev1.PodSucceeded,
				ContainerStatuses: []corev1.ContainerStatus{{State: corev1.ContainerState{Terminated: &corev1.ContainerStateTerminated{Reason: "Completed"}}}},
			}},
			want: "Succeeded",
		},
		"deletion shows Terminating": {
			pod:  corev1.Pod{ObjectMeta: metav1.ObjectMeta{DeletionTimestamp: &metav1.Time{}}, Status: corev1.PodStatus{Phase: corev1.PodRunning}},
			want: "Terminating",
		},
	}
	for name, tc := range tests {
		t.Run(name, func(t *testing.T) {
			if got := podStatusSummary(&tc.pod); got != tc.want {
				t.Errorf("podStatusSummary = %q, want %q", got, tc.want)
			}
		})
	}
}

func TestPodRestarts(t *testing.T) {
	pod := &corev1.Pod{Status: corev1.PodStatus{ContainerStatuses: []corev1.ContainerStatus{
		{RestartCount: 3}, {RestartCount: 5}, // sums across containers
	}}}
	if got := podRestarts(pod); got != 8 {
		t.Errorf("podRestarts = %d, want 8", got)
	}
	if got := podRestarts(&corev1.Service{}); got != 0 {
		t.Errorf("podRestarts(non-pod) = %d, want 0", got)
	}
}
