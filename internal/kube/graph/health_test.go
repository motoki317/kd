package graph

import (
	"strings"
	"testing"

	appsv1 "k8s.io/api/apps/v1"
	batchv1 "k8s.io/api/batch/v1"
	corev1 "k8s.io/api/core/v1"
	networkingv1 "k8s.io/api/networking/v1"
	policyv1 "k8s.io/api/policy/v1"
	"k8s.io/apimachinery/pkg/api/resource"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
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
		"unschedulable pending surfaces the PodScheduled reason, not a bare Pending": {
			pod: corev1.Pod{Status: corev1.PodStatus{
				Phase: corev1.PodPending,
				Conditions: []corev1.PodCondition{{
					Type: corev1.PodScheduled, Status: corev1.ConditionFalse, Reason: "Unschedulable",
					Message: "0/3 nodes are available: 3 Insufficient cpu.",
				}},
			}},
			want: "Unschedulable",
		},
		"a scheduled pending pod (PodScheduled true) still reads Pending": {
			pod: corev1.Pod{Status: corev1.PodStatus{
				Phase:      corev1.PodPending,
				Conditions: []corev1.PodCondition{{Type: corev1.PodScheduled, Status: corev1.ConditionTrue}},
			}},
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

// isFailureReason is a curated allowlist of terminal container-waiting reasons. The contract that
// matters: TRANSIENT reasons (a pod still pulling/creating/initializing) must NOT be treated as a
// failure, or every starting pod would flash Degraded. Pin both the recognized failures and the
// transient reasons that must stay healthy.
func TestIsFailureReason(t *testing.T) {
	for _, r := range []string{
		"CrashLoopBackOff", "ImagePullBackOff", "ErrImagePull",
		"CreateContainerError", "CreateContainerConfigError", "RunContainerError",
	} {
		if !isFailureReason(r) {
			t.Errorf("isFailureReason(%q) = false, want true (a real failure)", r)
		}
	}
	for _, r := range []string{"ContainerCreating", "PodInitializing", "", "Completed"} {
		if isFailureReason(r) {
			t.Errorf("isFailureReason(%q) = true, want false (transient/normal, not a failure)", r)
		}
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
		// Cordoned is an intentional hold (drain/maintenance), surfaced like a paused Deployment.
		{"cordoned but ready", node(corev1.ConditionTrue, true), HealthSuspended, "Ready,SchedulingDisabled"},
		// A real fault outranks the cordon: a cordoned node that's also down is Degraded, not Suspended.
		{"cordoned and not ready", node(corev1.ConditionFalse, true), HealthDegraded, "NotReady,SchedulingDisabled"},
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

func TestStatusSummaryIngress(t *testing.T) {
	rules := func(hosts ...string) *networkingv1.Ingress {
		ing := &networkingv1.Ingress{}
		for _, h := range hosts {
			ing.Spec.Rules = append(ing.Spec.Rules, networkingv1.IngressRule{Host: h})
		}
		return ing
	}
	tests := map[string]struct {
		ing  *networkingv1.Ingress
		want string
	}{
		"single host":             {rules("app.example.com"), "app.example.com"},
		"multiple distinct hosts": {rules("a.example.com", "b.example.com"), "a.example.com +1"},
		"duplicate hosts dedupe":  {rules("a.example.com", "a.example.com"), "a.example.com"},
		"host-less catch-all":     {rules(), "*"},
	}
	for name, tc := range tests {
		t.Run(name, func(t *testing.T) {
			if got := statusSummary(tc.ing); got != tc.want {
				t.Errorf("statusSummary(Ingress) = %q, want %q", got, tc.want)
			}
		})
	}
}

func TestPVHealthAndStatus(t *testing.T) {
	pv := func(phase corev1.PersistentVolumePhase, capacity string) *corev1.PersistentVolume {
		p := &corev1.PersistentVolume{Status: corev1.PersistentVolumeStatus{Phase: phase}}
		if capacity != "" {
			p.Spec.Capacity = corev1.ResourceList{corev1.ResourceStorage: resource.MustParse(capacity)}
		}
		return p
	}
	tests := []struct {
		name       string
		pv         *corev1.PersistentVolume
		wantHealth Health
		wantStatus string
	}{
		{"available", pv(corev1.VolumeAvailable, "20Gi"), HealthHealthy, "Available 20Gi"},
		{"bound", pv(corev1.VolumeBound, "20Gi"), HealthHealthy, "Bound 20Gi"},
		{"released", pv(corev1.VolumeReleased, ""), HealthProgressing, "Released"},
		{"failed", pv(corev1.VolumeFailed, ""), HealthDegraded, "Failed"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := health(tc.pv); got != tc.wantHealth {
				t.Errorf("health(PV %s) = %q, want %q", tc.name, got, tc.wantHealth)
			}
			if got := statusSummary(tc.pv); got != tc.wantStatus {
				t.Errorf("statusSummary(PV %s) = %q, want %q", tc.name, got, tc.wantStatus)
			}
		})
	}
}

func TestPVCHealthAndStatus(t *testing.T) {
	pvc := func(phase corev1.PersistentVolumeClaimPhase, capacity string) *corev1.PersistentVolumeClaim {
		p := &corev1.PersistentVolumeClaim{Status: corev1.PersistentVolumeClaimStatus{Phase: phase}}
		if capacity != "" {
			p.Status.Capacity = corev1.ResourceList{corev1.ResourceStorage: resource.MustParse(capacity)}
		}
		return p
	}
	tests := []struct {
		name       string
		pvc        *corev1.PersistentVolumeClaim
		wantHealth Health
		wantStatus string
	}{
		{"bound with capacity", pvc(corev1.ClaimBound, "10Gi"), HealthHealthy, "Bound 10Gi"},
		{"pending", pvc(corev1.ClaimPending, ""), HealthProgressing, "Pending"},
		{"lost", pvc(corev1.ClaimLost, ""), HealthDegraded, "Lost"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := health(tc.pvc); got != tc.wantHealth {
				t.Errorf("health(PVC %s) = %q, want %q", tc.name, got, tc.wantHealth)
			}
			if got := statusSummary(tc.pvc); got != tc.wantStatus {
				t.Errorf("statusSummary(PVC %s) = %q, want %q", tc.name, got, tc.wantStatus)
			}
		})
	}
}

func TestPDBHealthAndStatus(t *testing.T) {
	pdb := func(current, desired int32) *policyv1.PodDisruptionBudget {
		return &policyv1.PodDisruptionBudget{Status: policyv1.PodDisruptionBudgetStatus{
			CurrentHealthy: current, DesiredHealthy: desired,
		}}
	}
	tests := []struct {
		name       string
		pdb        *policyv1.PodDisruptionBudget
		wantHealth Health
		wantStatus string
	}{
		// At the floor → Healthy (no longer the old "Unknown" noise).
		{"meets floor exactly", pdb(8, 8), HealthHealthy, "8/8 healthy"},
		// Above the floor (current can exceed the minimum) → still Healthy.
		{"above floor", pdb(10, 8), HealthHealthy, "10/8 healthy"},
		// Below the floor → the protected workload is under its minimum → Degraded.
		{"below floor", pdb(6, 8), HealthDegraded, "6/8 healthy"},
		// A zero floor (e.g. a maxUnavailable PDB over one replica) drops the noisy "/0" denominator.
		{"zero floor with a healthy pod", pdb(1, 0), HealthHealthy, "1 healthy"},
		// A PDB matching no pods (zero floor, zero healthy) is satisfied, not alarmed.
		{"no pods", pdb(0, 0), HealthHealthy, "0 healthy"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := health(tc.pdb); got != tc.wantHealth {
				t.Errorf("health(PDB %s) = %q, want %q", tc.name, got, tc.wantHealth)
			}
			if got := statusSummary(tc.pdb); got != tc.wantStatus {
				t.Errorf("statusSummary(PDB %s) = %q, want %q", tc.name, got, tc.wantStatus)
			}
		})
	}
}

// A real PDB whose DisruptionAllowed condition is False for a benign reason (its workload's controller
// lacks the scale subresource → SyncFailed) but whose currentHealthy still meets the floor must read
// Healthy, NOT Degraded — health keys on the floor, not the disruption condition. This is the exact
// shape seen live (a PDB over Argo-Workflow pods) that motivated the rule.
func TestPDBHealthIgnoresBenignDisruptionBlocked(t *testing.T) {
	p := &policyv1.PodDisruptionBudget{Status: policyv1.PodDisruptionBudgetStatus{
		CurrentHealthy: 10, DesiredHealthy: 8, DisruptionsAllowed: 0,
		Conditions: []metav1.Condition{{Type: "DisruptionAllowed", Status: metav1.ConditionFalse, Reason: "SyncFailed"}},
	}}
	if got := health(p); got != HealthHealthy {
		t.Errorf("health(budget-met PDB with SyncFailed) = %q, want Healthy", got)
	}
}

func TestStatusMessage(t *testing.T) {
	// Healthy resources carry no message, whatever their status fields say (keeps the payload lean).
	healthyPod := &corev1.Pod{Status: corev1.PodStatus{Phase: corev1.PodRunning}}
	if got := statusMessage(healthyPod, HealthHealthy); got != "" {
		t.Errorf("statusMessage(healthy) = %q, want \"\"", got)
	}

	// A Pod's blocking condition (Unschedulable) carries the WHY the container statuses can't.
	unsched := &corev1.Pod{Status: corev1.PodStatus{
		Phase: corev1.PodPending,
		Conditions: []corev1.PodCondition{{
			Type: corev1.PodScheduled, Status: corev1.ConditionFalse, Reason: "Unschedulable",
			Message: "0/3 nodes are available: 3 Insufficient cpu.",
		}},
	}}
	if got := statusMessage(unsched, HealthProgressing); got != "0/3 nodes are available: 3 Insufficient cpu." {
		t.Errorf("statusMessage(unschedulable pod) = %q", got)
	}

	// A CR's status.message is the canonical failure reason (Argo Workflow / Rollout / many controllers).
	wf := &unstructured.Unstructured{Object: map[string]any{
		"apiVersion": "argoproj.io/v1alpha1", "kind": "Workflow",
		"status": map[string]any{"phase": "Failed", "message": "child 'step-2' failed"},
	}}
	if got := statusMessage(wf, HealthDegraded); got != "child 'step-2' failed" {
		t.Errorf("statusMessage(failed Workflow) = %q, want the status.message", got)
	}

	// A Deployment surfaces its degraded condition's message (ProgressDeadlineExceeded).
	deploy := &appsv1.Deployment{Status: appsv1.DeploymentStatus{Conditions: []appsv1.DeploymentCondition{{
		Type: appsv1.DeploymentProgressing, Status: corev1.ConditionFalse, Reason: "ProgressDeadlineExceeded",
		Message: "ReplicaSet \"web-abc\" has timed out progressing.",
	}}}}
	if got := statusMessage(deploy, HealthDegraded); got != "ReplicaSet \"web-abc\" has timed out progressing." {
		t.Errorf("statusMessage(stuck Deployment) = %q", got)
	}

	// Over-long messages are rune-capped so a pathological status can't bloat the payload.
	long := &unstructured.Unstructured{Object: map[string]any{
		"status": map[string]any{"message": strings.Repeat("x", 500)},
	}}
	got := statusMessage(long, HealthDegraded)
	if len([]rune(got)) != maxStatusMessage || !strings.HasSuffix(got, "…") {
		t.Errorf("statusMessage(long) len = %d (want %d, ellipsis-terminated)", len([]rune(got)), maxStatusMessage)
	}
}

func TestStatusSummaryService(t *testing.T) {
	svc := &corev1.Service{Spec: corev1.ServiceSpec{Type: corev1.ServiceTypeLoadBalancer}}
	if got := statusSummary(svc); got != "LoadBalancer" {
		t.Errorf("statusSummary(Service) = %q, want LoadBalancer", got)
	}
}

func TestDeploymentHealth(t *testing.T) {
	three := int32(3)
	tru := true

	// A rollout that blew its progress deadline is a failure, even while old replicas keep serving
	// (so replica counts alone would read it as Progressing forever).
	stuck := &appsv1.Deployment{
		Spec: appsv1.DeploymentSpec{Replicas: &three},
		Status: appsv1.DeploymentStatus{
			Replicas: 3, ReadyReplicas: 3, UpdatedReplicas: 1,
			Conditions: []appsv1.DeploymentCondition{{
				Type: appsv1.DeploymentProgressing, Status: corev1.ConditionFalse, Reason: "ProgressDeadlineExceeded",
			}},
		},
	}
	if got := health(stuck); got != HealthDegraded {
		t.Errorf("health(deadline-exceeded Deployment) = %q, want Degraded", got)
	}
	// "3/3" in red would be misleading; the chip should say the rollout failed.
	if got := statusSummary(stuck); got != "rollout failed" {
		t.Errorf("statusSummary(deadline-exceeded Deployment) = %q, want \"rollout failed\"", got)
	}

	// A normal in-progress rollout (new pods not all ready yet) is Progressing, not a failure.
	rolling := &appsv1.Deployment{
		Spec:   appsv1.DeploymentSpec{Replicas: &three},
		Status: appsv1.DeploymentStatus{Replicas: 3, ReadyReplicas: 3, UpdatedReplicas: 1},
	}
	if got := health(rolling); got != HealthProgressing {
		t.Errorf("health(rolling Deployment) = %q, want Progressing", got)
	}

	// A fully rolled-out Deployment is Healthy.
	ready := &appsv1.Deployment{
		Spec:   appsv1.DeploymentSpec{Replicas: &three},
		Status: appsv1.DeploymentStatus{Replicas: 3, ReadyReplicas: 3, UpdatedReplicas: 3},
	}
	if got := health(ready); got != HealthHealthy {
		t.Errorf("health(ready Deployment) = %q, want Healthy", got)
	}

	// A paused Deployment is deliberately held, not unhealthy.
	paused := &appsv1.Deployment{Spec: appsv1.DeploymentSpec{Replicas: &three, Paused: tru}}
	if got := health(paused); got != HealthSuspended {
		t.Errorf("health(paused Deployment) = %q, want Suspended", got)
	}
	if got := statusSummary(paused); got != "Paused" {
		t.Errorf("statusSummary(paused Deployment) = %q, want Paused", got)
	}

	// A normal Deployment still shows ready/desired.
	if got := statusSummary(ready); got != "3/3" {
		t.Errorf("statusSummary(ready Deployment) = %q, want 3/3", got)
	}
}

func TestDaemonSetHealth(t *testing.T) {
	// A DaemonSet wanting pods on no nodes (its nodeSelector matches nothing) is deliberately
	// scheduled nowhere, not unhealthy — desired 0 reads Healthy rather than "0/0" alarm.
	noTargets := &appsv1.DaemonSet{Status: appsv1.DaemonSetStatus{DesiredNumberScheduled: 0}}
	if got := health(noTargets); got != HealthHealthy {
		t.Errorf("health(no-target DaemonSet) = %q, want Healthy", got)
	}

	// Every desired pod ready AND updated → fully rolled out, Healthy.
	ready := &appsv1.DaemonSet{Status: appsv1.DaemonSetStatus{
		DesiredNumberScheduled: 3, NumberReady: 3, UpdatedNumberScheduled: 3,
	}}
	if got := health(ready); got != HealthHealthy {
		t.Errorf("health(ready DaemonSet) = %q, want Healthy", got)
	}

	// Pods wanted but NONE ready (e.g. a crash-looping agent on every node) is Degraded, not merely
	// Progressing — there is no partial service.
	down := &appsv1.DaemonSet{Status: appsv1.DaemonSetStatus{
		DesiredNumberScheduled: 3, NumberReady: 0, UpdatedNumberScheduled: 0,
	}}
	if got := health(down); got != HealthDegraded {
		t.Errorf("health(all-down DaemonSet) = %q, want Degraded", got)
	}

	// A rollout in flight — all old pods ready but not all on the new revision — is Progressing.
	rolling := &appsv1.DaemonSet{Status: appsv1.DaemonSetStatus{
		DesiredNumberScheduled: 3, NumberReady: 3, UpdatedNumberScheduled: 1,
	}}
	if got := health(rolling); got != HealthProgressing {
		t.Errorf("health(rolling DaemonSet) = %q, want Progressing", got)
	}

	// Some-but-not-all ready (partial outage) is also Progressing, not Degraded (some pods serve).
	partial := &appsv1.DaemonSet{Status: appsv1.DaemonSetStatus{
		DesiredNumberScheduled: 3, NumberReady: 2, UpdatedNumberScheduled: 2,
	}}
	if got := health(partial); got != HealthProgressing {
		t.Errorf("health(partial DaemonSet) = %q, want Progressing", got)
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

	// A Job's terminal condition drives its health: Complete → Healthy, Failed → Degraded.
	complete := &batchv1.Job{Status: batchv1.JobStatus{Conditions: []batchv1.JobCondition{
		{Type: batchv1.JobComplete, Status: corev1.ConditionTrue},
	}}}
	if got := health(complete); got != HealthHealthy {
		t.Errorf("health(complete Job) = %q, want Healthy", got)
	}
	failed := &batchv1.Job{Status: batchv1.JobStatus{Conditions: []batchv1.JobCondition{
		{Type: batchv1.JobFailed, Status: corev1.ConditionTrue},
	}}}
	if got := health(failed); got != HealthDegraded {
		t.Errorf("health(failed Job) = %q, want Degraded", got)
	}

	// A condition that isn't True is ignored (a JobFailed=False is not a failure); with no TRUE
	// terminal condition and not suspended, a running Job is Progressing.
	running := &batchv1.Job{Status: batchv1.JobStatus{Active: 1, Conditions: []batchv1.JobCondition{
		{Type: batchv1.JobFailed, Status: corev1.ConditionFalse},
	}}}
	if got := health(running); got != HealthProgressing {
		t.Errorf("health(running Job) = %q, want Progressing", got)
	}
}

func TestContainerStatuses(t *testing.T) {
	pod := &corev1.Pod{Status: corev1.PodStatus{
		InitContainerStatuses: []corev1.ContainerStatus{
			{Name: "setup", Ready: true, State: corev1.ContainerState{Terminated: &corev1.ContainerStateTerminated{Reason: "Completed"}}},
		},
		ContainerStatuses: []corev1.ContainerStatus{
			{Name: "app", Ready: true, RestartCount: 2, State: corev1.ContainerState{Running: &corev1.ContainerStateRunning{}}},
			{Name: "sidecar", Ready: false, State: corev1.ContainerState{Waiting: &corev1.ContainerStateWaiting{Reason: "CrashLoopBackOff"}}},
		},
	}}
	got := containerStatuses(pod)
	want := []ContainerStatus{
		{Name: "setup", Ready: true, State: "Terminated: Completed", Init: true},
		{Name: "app", Ready: true, Restarts: 2, State: "Running"},
		{Name: "sidecar", Ready: false, State: "Waiting: CrashLoopBackOff"},
	}
	if len(got) != len(want) {
		t.Fatalf("containerStatuses len = %d, want %d (%+v)", len(got), len(want), got)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("containerStatuses[%d] = %+v, want %+v", i, got[i], want[i])
		}
	}

	if got := containerStatuses(&corev1.Service{}); got != nil {
		t.Errorf("containerStatuses(non-pod) = %v, want nil", got)
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

	// Every workload kind podSpecOf knows must surface its template's image — especially CronJob,
	// whose spec nests the template one level deeper (JobTemplate.Spec.Template.Spec) and is the
	// easiest path to get wrong. tmpl is the shared `Spec.Template.Spec` payload.
	tmpl := corev1.PodTemplateSpec{Spec: corev1.PodSpec{Containers: []corev1.Container{{Name: "c", Image: "tmpl:v1"}}}}
	workloads := map[string]runtime.Object{
		"ReplicaSet":  &appsv1.ReplicaSet{Spec: appsv1.ReplicaSetSpec{Template: tmpl}},
		"StatefulSet": &appsv1.StatefulSet{Spec: appsv1.StatefulSetSpec{Template: tmpl}},
		"DaemonSet":   &appsv1.DaemonSet{Spec: appsv1.DaemonSetSpec{Template: tmpl}},
		"Job":         &batchv1.Job{Spec: batchv1.JobSpec{Template: tmpl}},
		"CronJob":     &batchv1.CronJob{Spec: batchv1.CronJobSpec{JobTemplate: batchv1.JobTemplateSpec{Spec: batchv1.JobSpec{Template: tmpl}}}},
	}
	for kind, obj := range workloads {
		if got := containerImages(obj); len(got) != 1 || got[0] != "tmpl:v1" {
			t.Errorf("containerImages(%s) = %v, want [tmpl:v1]", kind, got)
		}
	}
}

func TestContainerStateString(t *testing.T) {
	cases := []struct {
		desc  string
		state corev1.ContainerState
		want  string
	}{
		{"running", corev1.ContainerState{Running: &corev1.ContainerStateRunning{}}, "Running"},
		// A reason is the actionable bit (CrashLoopBackOff, ImagePullBackOff) — surface it with the state.
		{"waiting with reason", corev1.ContainerState{Waiting: &corev1.ContainerStateWaiting{Reason: "CrashLoopBackOff"}}, "Waiting: CrashLoopBackOff"},
		{"waiting no reason", corev1.ContainerState{Waiting: &corev1.ContainerStateWaiting{}}, "Waiting"},
		{"terminated with reason (clean exit, no code)", corev1.ContainerState{Terminated: &corev1.ContainerStateTerminated{Reason: "Error"}}, "Terminated: Error"},
		// A non-zero exit code is appended — exit 1 vs 137 (OOM/SIGKILL) is the actionable difference.
		{"terminated with reason and exit code", corev1.ContainerState{Terminated: &corev1.ContainerStateTerminated{Reason: "Error", ExitCode: 1}}, "Terminated: Error (exit 1)"},
		{"terminated OOMKilled with exit code", corev1.ContainerState{Terminated: &corev1.ContainerStateTerminated{Reason: "OOMKilled", ExitCode: 137}}, "Terminated: OOMKilled (exit 137)"},
		{"terminated exit code only, no reason", corev1.ContainerState{Terminated: &corev1.ContainerStateTerminated{ExitCode: 2}}, "Terminated: exit 2"},
		{"terminated no reason", corev1.ContainerState{Terminated: &corev1.ContainerStateTerminated{}}, "Terminated"},
		// The zero state (no field set) is the brief window before kubelet reports — "Unknown", not a crash.
		{"empty", corev1.ContainerState{}, "Unknown"},
	}
	for _, c := range cases {
		if got := containerStateString(c.state); got != c.want {
			t.Errorf("%s: containerStateString = %q, want %q", c.desc, got, c.want)
		}
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

// podReady reads the PodReady condition. The absent-condition path must be false (a pod with no
// conditions yet is NOT ready) — distinct from an explicit Ready=False — so a just-created pod never
// reads ready before its status is populated.
func TestPodReady(t *testing.T) {
	withReady := func(s corev1.ConditionStatus) *corev1.Pod {
		return &corev1.Pod{Status: corev1.PodStatus{Conditions: []corev1.PodCondition{{Type: corev1.PodReady, Status: s}}}}
	}
	if !podReady(withReady(corev1.ConditionTrue)) {
		t.Error("podReady(Ready=True) = false, want true")
	}
	if podReady(withReady(corev1.ConditionFalse)) {
		t.Error("podReady(Ready=False) = true, want false")
	}
	if podReady(&corev1.Pod{}) {
		t.Error("podReady(no conditions) = true, want false")
	}
}
