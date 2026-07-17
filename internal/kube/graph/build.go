package graph

import (
	"cmp"
	"slices"
	"time"

	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
)

// Build assembles the relationship graph from a snapshot of Kubernetes objects. It is pure:
// the same input always yields the same graph, with nodes and edges in a deterministic order.
//
// Input objects may be typed (corev1.Pod, …) or *unstructured.Unstructured (the shape the
// dynamic-informer store yields). Known kinds are converted to their typed struct at the
// entry boundary so per-kind logic (health rules, edge inferrers) keeps working as-is;
// unknown kinds (custom resources) stay unstructured and flow through the CR-specific paths.
func Build(objs []runtime.Object) *Graph { return buildGraph(objs, nil, false) }

// BuildWithLogSources builds the displayed objects while using sourcePods only to determine which
// visible resources can resolve logs.
func BuildWithLogSources(objs, sourcePods []runtime.Object) *Graph {
	return buildGraph(objs, sourcePods, false)
}

// BuildForLogs is Build but keeps completed controller-pods — the finished Job/CronJob/Workflow runs
// whose logs are the entire reason to inspect them (the displayed topology drops them as clutter, but
// log aggregation MUST reach them or a completed run's Logs tab is silently empty). Superseded
// ReplicaSets are still dropped, so a Deployment's aggregated logs don't pull in its old revisions'
// pods. Used only for log/pod resolution (podsForResource), never for the displayed graph.
func BuildForLogs(objs []runtime.Object) *Graph { return buildGraph(objs, nil, true) }

func loggableFloor(kind string) bool {
	switch kind {
	case "Pod", "ReplicationController", "ReplicaSet", "Deployment", "StatefulSet", "DaemonSet",
		"Job", "CronJob", "Workflow", "CronWorkflow":
		return true
	default:
		return false
	}
}

func buildGraph(objs, sourcePods []runtime.Object, keepCompletedPods bool) *Graph {
	// Non-nil Nodes so an empty graph marshals `"nodes":[]`, not `null` (Edges is guarded after
	// buildEdges below, which reassigns it).
	g := &Graph{Nodes: []Node{}}
	objs = slices.Clone(objs)
	for i, o := range objs {
		objs[i] = toTyped(o)
	}
	loggable := loggableUIDs(objs, sourcePods)
	objs = slices.DeleteFunc(objs, func(o runtime.Object) bool { return excludedFromBuild(o, keepCompletedPods) })
	for _, obj := range objs {
		kind, apiVersion, m, ok := describe(obj)
		if !ok {
			continue
		}
		h := health(obj)
		node := Node{
			ID:                nodeID(kind, m),
			Kind:              kind,
			APIVersion:        apiVersion,
			Namespace:         m.GetNamespace(),
			Name:              m.GetName(),
			Labels:            m.GetLabels(),
			Health:            h,
			Loggable:          loggableFloor(kind) || loggable[string(m.GetUID())],
			Status:            statusSummary(obj),
			Message:           statusMessage(obj, h),
			CreatedAt:         creationTime(m),
			Restarts:          podRestarts(obj),
			Containers:        containerNames(obj),
			InitContainers:    initContainerNames(obj),
			Images:            containerImages(obj),
			Host:              podHost(obj),
			Capacity:          nodeCapacity(obj),
			Taints:            nodeTaints(obj),
			NetPol:            networkPolicySummary(obj),
			Allocatable:       nodeAllocatable(obj),
			CapacityRes:       nodeTotalCapacity(obj),
			Requests:          podRequests(obj),
			Limits:            podLimits(obj),
			ClusterIP:         serviceClusterIP(obj),
			ExternalIP:        externalAddress(obj),
			Ports:             servicePorts(obj),
			Selector:          serviceSelector(obj),
			NodeSelector:      dsNodeSelector(obj),
			Routes:            routes(obj),
			Scrapes:           scrapeConfig(obj),
			Rules:             roleRules(obj),
			RoleRef:           bindingRoleRef(obj),
			Subjects:          bindingSubjects(obj),
			DataKeys:          dataKeys(obj),
			QuotaUsage:        quotaUsage(obj),
			SecretType:        secretType(obj),
			AccessModes:       accessModes(obj),
			StorageClass:      storageClass(obj),
			LastRun:           cronLastRun(obj),
			Active:            batchActive(obj),
			Failed:            batchFailed(obj),
			ScaleReplicas:     hpaScale(obj),
			ScaleRange:        hpaRange(obj),
			ScaleMetrics:      hpaMetrics(obj),
			AppDest:           argoAppDest(obj),
			AppRevision:       argoAppRevision(obj),
			PDBPolicy:         pdbPolicy(obj),
			Disruptions:       pdbDisruptions(obj),
			Provisioner:       storageClassProvisioner(obj),
			ReclaimPolicy:     storageClassReclaim(obj),
			VolumeBinding:     storageClassBinding(obj),
			Expandable:        storageClassExpandable(obj),
			CertNames:         certNames(obj),
			CertIssuer:        certIssuer(obj),
			CertExpiry:        certExpiry(obj),
			IssuerConfig:      issuerConfig(obj),
			ContainerStatuses: containerStatuses(obj),
		}
		for _, or := range m.GetOwnerReferences() {
			node.OwnerUIDs = append(node.OwnerUIDs, string(or.UID))
		}
		g.Nodes = append(g.Nodes, node)
	}

	var endpoints map[string]*Endpoints
	g.Edges, endpoints = buildEdges(g.Nodes, objs, newIndex(g.Nodes))
	// buildEdges returns a nil slice when nothing relates (a namespace of standalone resources — only
	// a ConfigMap + ServiceAccount, say). A nil slice marshals as JSON `null`, which the client's
	// snapshot reducer (`[...g.edges]`) threw on, hanging the whole namespace on "connecting…" forever.
	// `edges` is non-optional in the wire contract, so force `[]`.
	if g.Edges == nil {
		g.Edges = []Edge{}
	}
	annotateServiceEndpoints(g.Nodes, endpoints)
	sortGraph(g)
	return g
}

func loggableUIDs(objs, sourcePods []runtime.Object) map[string]bool {
	if len(sourcePods) == 0 {
		return nil
	}
	byUID := make(map[string]runtime.Object, len(objs)+len(sourcePods))
	for _, obj := range objs {
		if m, err := meta.Accessor(obj); err == nil && m.GetUID() != "" {
			byUID[string(m.GetUID())] = obj
		}
	}
	for _, pod := range sourcePods {
		if m, err := meta.Accessor(pod); err == nil && m.GetUID() != "" {
			byUID[string(m.GetUID())] = pod
		}
	}

	loggable := make(map[string]bool, len(sourcePods))
	stack := make([]string, 0, len(sourcePods))
	for _, pod := range sourcePods {
		kind, _, m, ok := describe(pod)
		if ok && kind == "Pod" && m.GetUID() != "" {
			stack = append(stack, string(m.GetUID()))
		}
	}
	for len(stack) > 0 {
		uid := stack[len(stack)-1]
		stack = stack[:len(stack)-1]
		if _, seen := loggable[uid]; seen {
			continue
		}
		loggable[uid] = false
		obj, ok := byUID[uid]
		if !ok || excludedFromBuild(obj, true) {
			continue
		}
		loggable[uid] = true
		m, err := meta.Accessor(obj)
		if err != nil {
			continue
		}
		for _, owner := range m.GetOwnerReferences() {
			if owner.UID != "" {
				stack = append(stack, string(owner.UID))
			}
		}
	}
	return loggable
}

func excludedFromBuild(obj runtime.Object, keepCompletedPods bool) bool {
	return isHistorical(obj, keepCompletedPods) || isAutoInjectedNoise(obj)
}

// isHistorical reports whether an object is finished/superseded clutter that the topology drops
// unconditionally (rather than behind a toggle), because it dominates real namespaces and never
// reflects current state:
//   - ReplicaSets scaled to zero with no pods (Deployment revision history, ~10 kept by default).
//   - Pods that ran to completion under a controller (Job/CronJob/Workflow leftovers). Failed pods
//     are kept (they are actionable) and ownerless succeeded pods are kept (someone ran them).
//
// keepCompletedPods overrides the pod rule for log aggregation (BuildForLogs): a finished run's
// completed pod IS its logs, so it must survive even though the topology hides it. The ReplicaSet
// rule still applies, so a Deployment's old revisions never leak into its aggregated logs.
func isHistorical(obj runtime.Object, keepCompletedPods bool) bool {
	switch o := obj.(type) {
	case *appsv1.ReplicaSet:
		desiredZero := o.Spec.Replicas != nil && *o.Spec.Replicas == 0
		return desiredZero && o.Status.Replicas == 0 && metav1.GetControllerOf(&o.ObjectMeta) != nil
	case *corev1.Pod:
		if keepCompletedPods {
			return false
		}
		return o.Status.Phase == corev1.PodSucceeded && metav1.GetControllerOf(&o.ObjectMeta) != nil
	default:
		return false
	}
}

// isAutoInjectedNoise reports whether an object is cluster machinery that every namespace carries
// identically and an operator never manages — currently the kube-root-ca.crt ConfigMap that the
// root-ca-cert-publisher controller injects into every namespace and the kubelet auto-mounts into
// every pod's projected SA-token volume. Dropping its node keeps it out of the graph entirely (no
// node → its mount edges drop with it, since `link` skips unknown targets), so it can't appear as a
// star hub wired to every pod NOR as the lone orphan ConfigMap it otherwise floated as — pure noise
// the operator asked to hide. Filtered here, the single source of truth, rather than re-checked per
// edge inferrer.
func isAutoInjectedNoise(obj runtime.Object) bool {
	cm, ok := obj.(*corev1.ConfigMap)
	return ok && cm.Name == "kube-root-ca.crt"
}

// KindOf returns an object's Kubernetes kind, recovered from TypeMeta or the Go type. It lets
// other packages classify cache objects (whose TypeMeta is empty) without duplicating the map.
func KindOf(obj runtime.Object) string {
	kind, _, _, _ := describe(obj)
	return kind
}

// GVKOf returns an object's apiVersion and kind, recovered from the Go type when it came from an
// informer lister (whose TypeMeta is empty). Lets a caller stamp the GVK back onto a manifest so the
// served YAML/JSON carries apiVersion/kind and applies cleanly.
func GVKOf(obj runtime.Object) (apiVersion, kind string) {
	k, av, _, _ := describe(obj)
	return av, k
}

// creationTime renders an object's creation timestamp as RFC3339, or "" when unset (e.g. fixtures),
// so the client can show a relative age.
func creationTime(m metav1.Object) string {
	t := m.GetCreationTimestamp()
	if t.IsZero() {
		return ""
	}
	return t.UTC().Format(time.RFC3339)
}

// nodeID is the object UID, falling back to a stable synthetic id when UID is absent.
func nodeID(kind string, m metav1.Object) string {
	if uid := string(m.GetUID()); uid != "" {
		return uid
	}
	return kind + "/" + m.GetNamespace() + "/" + m.GetName()
}

// describe extracts the kind, apiVersion, and metadata accessor for an object. Kind/apiVersion
// come from TypeMeta when set (e.g. decoded fixtures) and fall back to the Go type otherwise
// (e.g. objects from informer listers, whose TypeMeta is empty).
func describe(obj runtime.Object) (kind, apiVersion string, m metav1.Object, ok bool) {
	m, err := meta.Accessor(obj)
	if err != nil {
		return "", "", nil, false
	}
	gvk := obj.GetObjectKind().GroupVersionKind()
	kind, apiVersion = gvk.Kind, gvk.GroupVersion().String()
	if kind == "" {
		kind, apiVersion = kindFromType(obj)
	}
	return kind, apiVersion, m, kind != ""
}

// sortGraph orders nodes by (kind, namespace, name, id) and edges by (type, from, to) so the
// builder's output is stable and assertions/diffs are deterministic.
func sortGraph(g *Graph) {
	slices.SortFunc(g.Nodes, func(a, b Node) int {
		return cmp.Or(
			cmp.Compare(a.Kind, b.Kind),
			cmp.Compare(a.Namespace, b.Namespace),
			cmp.Compare(a.Name, b.Name),
			cmp.Compare(a.ID, b.ID),
		)
	})
	slices.SortFunc(g.Edges, func(a, b Edge) int {
		return cmp.Or(
			cmp.Compare(string(a.Type), string(b.Type)),
			cmp.Compare(a.From, b.From),
			cmp.Compare(a.To, b.To),
		)
	})
}
