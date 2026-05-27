package graph

import (
	"testing"

	appsv1 "k8s.io/api/apps/v1"
	batchv1 "k8s.io/api/batch/v1"
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
		"failing init container shows Init:<reason>": {
			pod: corev1.Pod{Status: corev1.PodStatus{
				Phase:                 corev1.PodPending,
				InitContainerStatuses: []corev1.ContainerStatus{{State: corev1.ContainerState{Waiting: &corev1.ContainerStateWaiting{Reason: "CrashLoopBackOff"}}}},
			}},
			want: "Init:CrashLoopBackOff",
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

func TestPodHealthFailingInitContainer(t *testing.T) {
	pod := &corev1.Pod{Status: corev1.PodStatus{
		Phase:                 corev1.PodPending,
		InitContainerStatuses: []corev1.ContainerStatus{{State: corev1.ContainerState{Waiting: &corev1.ContainerStateWaiting{Reason: "CrashLoopBackOff"}}}},
	}}
	if got := health(pod); got != HealthDegraded {
		t.Errorf("health(init crash-loop) = %q, want Degraded", got)
	}
}

func TestNodeHealthAndStatus(t *testing.T) {
	node := func(ready corev1.ConditionStatus, unschedulable bool, extra ...corev1.NodeCondition) *corev1.Node {
		conds := append([]corev1.NodeCondition{{Type: corev1.NodeReady, Status: ready}}, extra...)
		return &corev1.Node{Spec: corev1.NodeSpec{Unschedulable: unschedulable}, Status: corev1.NodeStatus{Conditions: conds}}
	}

	tests := []struct {
		name       string
		node       *corev1.Node
		wantHealth Health
		wantStatus string
	}{
		{"ready", node(corev1.ConditionTrue, false), HealthHealthy, "Ready"},
		{"not ready", node(corev1.ConditionFalse, false), HealthDegraded, "NotReady"},
		{"cordoned but ready", node(corev1.ConditionTrue, true), HealthHealthy, "Ready,SchedulingDisabled"},
		{
			"memory pressure",
			node(corev1.ConditionTrue, false, corev1.NodeCondition{Type: corev1.NodeMemoryPressure, Status: corev1.ConditionTrue}),
			HealthDegraded, "Ready",
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := health(tc.node); got != tc.wantHealth {
				t.Errorf("health = %q, want %q", got, tc.wantHealth)
			}
			if got := statusSummary(tc.node); got != tc.wantStatus {
				t.Errorf("status = %q, want %q", got, tc.wantStatus)
			}
		})
	}
}

func TestStatusSummaryService(t *testing.T) {
	svc := &corev1.Service{Spec: corev1.ServiceSpec{Type: corev1.ServiceTypeLoadBalancer}}
	if got := statusSummary(svc); got != "LoadBalancer" {
		t.Errorf("statusSummary(Service) = %q, want LoadBalancer", got)
	}
}

func TestStatusSummaryJobAndCronJob(t *testing.T) {
	three := int32(3)
	suspended := true
	job := &batchv1.Job{Spec: batchv1.JobSpec{Completions: &three}, Status: batchv1.JobStatus{Succeeded: 1}}
	if got := statusSummary(job); got != "1/3" {
		t.Errorf("statusSummary(Job) = %q, want 1/3", got)
	}
	suspendedJob := &batchv1.Job{Spec: batchv1.JobSpec{Suspend: &suspended, Completions: &three}}
	if got := statusSummary(suspendedJob); got != "Suspended" {
		t.Errorf("statusSummary(suspended Job) = %q, want Suspended", got)
	}
	if got := health(suspendedJob); got != HealthSuspended {
		t.Errorf("health(suspended Job) = %q, want Suspended", got)
	}
	cj := &batchv1.CronJob{Spec: batchv1.CronJobSpec{Schedule: "*/5 * * * *", Suspend: &suspended}}
	if got := statusSummary(cj); got != "Suspended" {
		t.Errorf("statusSummary(suspended CronJob) = %q, want Suspended", got)
	}
	if got := health(cj); got != HealthSuspended {
		t.Errorf("health(suspended CronJob) = %q, want Suspended", got)
	}
	active := &batchv1.CronJob{Spec: batchv1.CronJobSpec{Schedule: "*/5 * * * *"}}
	if got := statusSummary(active); got != "*/5 * * * *" {
		t.Errorf("statusSummary(active CronJob) = %q, want the schedule", got)
	}
	if got := health(active); got != HealthHealthy {
		t.Errorf("health(active CronJob) = %q, want Healthy", got)
	}
}

func TestContainerImages(t *testing.T) {
	pod := &corev1.Pod{Spec: corev1.PodSpec{Containers: []corev1.Container{
		{Name: "app", Image: "nginx:1.25"}, {Name: "sidecar", Image: "envoy:1.29"}, {Name: "dup", Image: "nginx:1.25"},
	}}}
	if got := containerImages(pod); len(got) != 2 || got[0] != "nginx:1.25" || got[1] != "envoy:1.29" {
		t.Errorf("containerImages(pod) = %v, want [nginx:1.25 envoy:1.29] (deduped, ordered)", got)
	}

	// Workloads expose their pod template's images, not just bare pods.
	deploy := &appsv1.Deployment{Spec: appsv1.DeploymentSpec{Template: corev1.PodTemplateSpec{
		Spec: corev1.PodSpec{Containers: []corev1.Container{{Name: "web", Image: "app:v2"}}},
	}}}
	if got := containerImages(deploy); len(got) != 1 || got[0] != "app:v2" {
		t.Errorf("containerImages(deployment) = %v, want [app:v2]", got)
	}

	if got := containerImages(&corev1.Service{}); got != nil {
		t.Errorf("containerImages(non-workload) = %v, want nil", got)
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
