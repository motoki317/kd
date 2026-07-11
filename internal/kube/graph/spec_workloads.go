package graph

// Workload-running essence — DaemonSet placement, Job/CronJob (and Argo CronWorkflow) batch counts,
// schedules and last runs, and HPA scale state/range/metrics.

import (
	"fmt"
	"strings"
	"time"

	appsv1 "k8s.io/api/apps/v1"
	batchv1 "k8s.io/api/batch/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
)

// dsNodeSelector formats a DaemonSet's node selector — "which nodes does this run on" is a DS's
// defining fact, and a selector matching no node is exactly why one shows a contented "0/0".
func dsNodeSelector(obj runtime.Object) string {
	d, ok := obj.(*appsv1.DaemonSet)
	if !ok {
		return ""
	}
	return labelMapString(d.Spec.Template.Spec.NodeSelector)
}

// batchActive returns how many pods/jobs a Job or CronJob has running right now ("is one running?"),
// the answer the "succeeded/total" status and schedule expression both omit. 0 for other kinds.
func batchActive(obj runtime.Object) int32 {
	switch o := obj.(type) {
	case *batchv1.Job:
		return o.Status.Active
	case *batchv1.CronJob:
		return int32(len(o.Status.Active))
	}
	return 0
}

// batchFailed returns a Job's failed-pod count — burning retries that the "succeeded/total" status
// hides (a Job at "0/1" with 5 failures looks merely pending). 0 for other kinds.
func batchFailed(obj runtime.Object) int32 {
	if o, ok := obj.(*batchv1.Job); ok {
		return o.Status.Failed
	}
	return 0
}

// cronLastRun returns a cron resource's last schedule time as RFC3339 (empty when it has never fired
// or for other kinds) — the "did my cron actually run?" answer the schedule expression alone can't
// give. Covers both a typed batch/v1 CronJob and an Argo CronWorkflow (a CR, navigated by field path:
// status.lastScheduledTime), so the drawer's "last run" chip works for both.
func cronLastRun(obj runtime.Object) string {
	if o, ok := obj.(*batchv1.CronJob); ok && o.Status.LastScheduleTime != nil {
		return o.Status.LastScheduleTime.UTC().Format(time.RFC3339)
	}
	if u := asUnstructuredKind(obj, "CronWorkflow"); u != nil {
		if t, ok, _ := unstructured.NestedString(u.Object, "status", "lastScheduledTime"); ok {
			return t
		}
	}
	return ""
}

// cronWorkflowSchedule renders an Argo CronWorkflow's cron schedule(s) with its timezone, the "when
// does this run" the status line otherwise omits. Argo v3 uses spec.schedules (a list); older
// CronWorkflows used the singular spec.schedule — both are handled. Empty for non-CronWorkflows.
func cronWorkflowSchedule(obj runtime.Object) string {
	u := asUnstructuredKind(obj, "CronWorkflow")
	if u == nil {
		return ""
	}
	var crons []string
	if list, ok, _ := unstructured.NestedStringSlice(u.Object, "spec", "schedules"); ok {
		crons = list
	} else if one, ok, _ := unstructured.NestedString(u.Object, "spec", "schedule"); ok && one != "" {
		crons = []string{one}
	}
	if len(crons) == 0 {
		return ""
	}
	sched := strings.Join(crons, ", ")
	if tz, ok, _ := unstructured.NestedString(u.Object, "spec", "timezone"); ok && tz != "" {
		sched += " (" + tz + ")"
	}
	return sched
}

// hpaScale extracts a HorizontalPodAutoscaler's replica state — "current" when stable, "current → desired"
// mid-scale — answering "how many is it running, and is it actively scaling?". Empty for non-HPAs. An HPA
// has no typed factory here, so it arrives unstructured and is navigated by field path (the autoscaling
// v1/v2 schemas share these status field names).
func hpaScale(obj runtime.Object) string {
	u := asUnstructuredKind(obj, "HorizontalPodAutoscaler")
	if u == nil {
		return ""
	}
	cur, hasCur, _ := unstructured.NestedInt64(u.Object, "status", "currentReplicas")
	des, hasDes, _ := unstructured.NestedInt64(u.Object, "status", "desiredReplicas")
	if !hasCur && !hasDes {
		return "" // status not populated yet (freshly created) — nothing to show
	}
	// desiredReplicas 0 means "couldn't compute" (an HPA never scales to zero — minReplicas ≥ 1),
	// so "1 → 0" would read as an impossible scale-down on a broken autoscaler.
	if hasDes && des > 0 && des != cur {
		return fmt.Sprintf("%d → %d", cur, des)
	}
	// "at max" only for ScalingLimited's TooManyReplicas reason: demand wants MORE than the ceiling
	// — the "workload is slow but the HPA shows green" saturation a beginner can't infer from
	// comparing the replica and range chips. TooFewReplicas (pinned at min) stays unmarked: idling
	// at the floor is the normal steady state, the reason ScalingLimited overall is no health signal.
	if conds, found, _ := unstructured.NestedSlice(u.Object, "status", "conditions"); found {
		for _, c := range conds {
			if m, ok := c.(map[string]any); ok && m["type"] == "ScalingLimited" && m["status"] == "True" && m["reason"] == "TooManyReplicas" {
				return fmt.Sprintf("%d · at max", cur)
			}
		}
	}
	return fmt.Sprintf("%d", cur)
}

// hpaRange extracts an HPA's min–max replica bounds ("2–10"); minReplicas defaults to 1 when unset
// (matching the API default). Empty for non-HPAs or when maxReplicas is unset.
func hpaRange(obj runtime.Object) string {
	u := asUnstructuredKind(obj, "HorizontalPodAutoscaler")
	if u == nil {
		return ""
	}
	maxR, hasMax, _ := unstructured.NestedInt64(u.Object, "spec", "maxReplicas")
	if !hasMax {
		return ""
	}
	minR, hasMin, _ := unstructured.NestedInt64(u.Object, "spec", "minReplicas")
	if !hasMin {
		minR = 1
	}
	return fmt.Sprintf("%d–%d", minR, maxR)
}

// hpaMetricSide renders one side of an HPA Resource metric — "72%" (averageUtilization) or the raw
// quantity ("100m", averageValue) — from a v2 `target`/`current` block. Empty when neither is set.
func hpaMetricSide(m map[string]any) string {
	if m == nil {
		return ""
	}
	if v, ok := nestedNum(m, "averageUtilization"); ok {
		return fmt.Sprintf("%d%%", v)
	}
	if s, ok := m["averageValue"].(string); ok {
		return s
	}
	return ""
}

// hpaResourceMetric unwraps one HPA metric entry as a Resource-type metric, returning its resource
// name and the (current/target/etc.) map both hpaMetrics loops navigate. ok is false for a non-map
// entry, a non-Resource metric type, or a missing resource block — the skip both loops share.
func hpaResourceMetric(entry any) (name string, res map[string]any, ok bool) {
	mm, isMap := entry.(map[string]any)
	if !isMap || mm["type"] != "Resource" {
		return "", nil, false
	}
	res, _ = mm["resource"].(map[string]any)
	if res == nil {
		return "", nil, false
	}
	name, _ = res["name"].(string)
	return name, res, true
}

// hpaMetrics renders the metric actually driving an HPA's decision — "cpu 72% / 80%" (current /
// target) — the fact the replica counts alone can't explain ("why is it scaling?" / "how close to
// the trigger is it?"). Covers the Resource metric type (the overwhelmingly common case: CPU/memory
// utilization or averageValue), joining several with " · "; Pods/Object/External metrics are skipped
// rather than half-rendered. A current side missing (metrics not yet sampled, or metrics-server
// down) renders as "—" so the configured target still shows. Falls back to the autoscaling/v1
// targetCPUUtilizationPercentage schema when spec.metrics is absent.
func hpaMetrics(obj runtime.Object) string {
	u := asUnstructuredKind(obj, "HorizontalPodAutoscaler")
	if u == nil {
		return ""
	}
	// Index the sampled side by resource name first; spec order drives the output order.
	currentByName := map[string]string{}
	current, _, _ := unstructured.NestedSlice(u.Object, "status", "currentMetrics")
	for _, m := range current {
		name, res, ok := hpaResourceMetric(m)
		if !ok {
			continue
		}
		cur, _ := res["current"].(map[string]any)
		if side := hpaMetricSide(cur); side != "" {
			currentByName[name] = side
		}
	}
	var parts []string
	metrics, _, _ := unstructured.NestedSlice(u.Object, "spec", "metrics")
	for _, m := range metrics {
		name, res, ok := hpaResourceMetric(m)
		if !ok {
			continue
		}
		tgt, _ := res["target"].(map[string]any)
		target := hpaMetricSide(tgt)
		if name == "" || target == "" {
			continue
		}
		cur := currentByName[name]
		if cur == "" {
			cur = "—"
		}
		parts = append(parts, fmt.Sprintf("%s %s / %s", name, cur, target))
	}
	if len(parts) == 0 {
		if t, ok, _ := unstructured.NestedInt64(u.Object, "spec", "targetCPUUtilizationPercentage"); ok {
			cur := "—"
			if c, ok2, _ := unstructured.NestedInt64(u.Object, "status", "currentCPUUtilizationPercentage"); ok2 {
				cur = fmt.Sprintf("%d%%", c)
			}
			parts = append(parts, fmt.Sprintf("cpu %s / %d%%", cur, t))
		}
	}
	return strings.Join(parts, " · ")
}
