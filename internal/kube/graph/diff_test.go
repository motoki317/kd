package graph

import (
	"encoding/json"
	"reflect"
	"slices"
	"strings"
	"testing"
)

func TestNodeLoggableWireContract(t *testing.T) {
	typ := reflect.TypeOf(Node{})
	field, ok := typ.FieldByName("Loggable")
	if !ok {
		t.Fatal("Node must expose Loggable")
	}
	if got := field.Tag.Get("json"); got != "loggable,omitempty" {
		t.Fatalf("Node.Loggable json tag = %q, want loggable,omitempty", got)
	}

	node := reflect.New(typ).Elem()
	node.FieldByName("Loggable").SetBool(true)
	data, err := json.Marshal(node.Interface())
	if err != nil {
		t.Fatal(err)
	}
	if got := string(data); !strings.Contains(got, `"loggable":true`) {
		t.Fatalf("true Loggable must marshal on the wire, got %s", got)
	}
}

func TestDiff(t *testing.T) {
	prev := &Graph{
		Nodes: []Node{
			{ID: "a", Kind: "Pod", Name: "a", Health: HealthHealthy},
			{ID: "b", Kind: "Pod", Name: "b", Health: HealthHealthy},
		},
		Edges: []Edge{
			{From: "a", To: "b", Type: EdgeOwner},
		},
	}
	next := &Graph{
		Nodes: []Node{
			{ID: "a", Kind: "Pod", Name: "a", Health: HealthDegraded}, // changed health
			{ID: "c", Kind: "Pod", Name: "c", Health: HealthHealthy},  // added; b removed
		},
		Edges: []Edge{
			{From: "a", To: "c", Type: EdgeOwner}, // added; a->b removed
		},
	}

	p := Diff(prev, next)

	upsertIDs := func() []string {
		var ids []string
		for _, n := range p.UpsertNodes {
			ids = append(ids, n.ID)
		}
		slices.Sort(ids)
		return ids
	}()
	if want := []string{"a", "c"}; !slices.Equal(upsertIDs, want) {
		t.Errorf("upsert node ids = %v, want %v (a changed, c added)", upsertIDs, want)
	}
	if !slices.Equal(p.RemoveNodeIDs, []string{"b"}) {
		t.Errorf("remove node ids = %v, want [b]", p.RemoveNodeIDs)
	}
	if len(p.UpsertEdges) != 1 || p.UpsertEdges[0].To != "c" {
		t.Errorf("upsert edges = %v, want [a->c]", p.UpsertEdges)
	}
	if len(p.RemoveEdges) != 1 || p.RemoveEdges[0].To != "b" {
		t.Errorf("remove edges = %v, want [a->b]", p.RemoveEdges)
	}
}

func TestDiffEmptyWhenUnchanged(t *testing.T) {
	g := Build(decodeFixture(t, ownershipFixture))
	if p := Diff(g, g); !p.Empty() {
		t.Errorf("diff of identical graphs should be empty, got %+v", p)
	}
}

// nodeEqual drives change detection: a material field changing must make two nodes unequal so the SSE
// diff emits an upsert and the client repaints. Every field added to the Node (a recurring source of
// "I forgot to add it to nodeEqual") is exercised here so an omission fails loudly rather than silently
// dropping live updates. A handful of static/cosmetic fields are deliberately ignored — asserted too,
// so the exclusion stays a conscious choice.
func baseNode() Node {
	cpu, mem := int64(2000), int64(4<<30)
	return Node{
		ID: "id", Kind: "Pod", APIVersion: "v1", Namespace: "ns", Name: "n",
		Health: HealthHealthy, Status: "Running", Restarts: 1, Host: "node-1",
		Capacity: "16 vCPU", ClusterIP: "10.0.0.1", ExternalIP: "pending", Ports: []string{"80/TCP"},
		Routes: []string{"h/p → s:80"}, Rules: []string{"pods: get"}, RoleRef: "Role/r",
		Subjects: []string{"User: a"}, Containers: []string{"app"}, Images: []string{"img:1"},
		CreatedAt: "2026-01-01T00:00:00Z", Labels: map[string]string{"app": "x"}, OwnerUIDs: []string{"o"},
		ContainerStatuses: []ContainerStatus{{Name: "app", Ready: true, State: "Running"}},
		Endpoints:         &Endpoints{Ready: 1, Total: 2},
		Requests:          &Resources{CPUMilli: &cpu, MemBytes: &mem},
	}
}

// Each mutation reassigns one field (never mutates a shared slice/map/pointer in place).
// Together with ignoredFieldCases this table must DECIDE every Node field — enforced by
// TestNodeEqualDecidesEveryField, because an undecided field is how repaint bugs ship (Selector
// was set by build.go but missing from nodeEqual, and the drawer's selector chip went stale).
var changedFieldCases = []struct {
	field string
	mut   func(n *Node)
}{
	{"ID", func(n *Node) { n.ID = "id2" }},
	{"Kind", func(n *Node) { n.Kind = "Service" }},
	{"APIVersion", func(n *Node) { n.APIVersion = "apps/v1" }},
	{"Namespace", func(n *Node) { n.Namespace = "ns2" }},
	{"Name", func(n *Node) { n.Name = "n2" }},
	{"Health", func(n *Node) { n.Health = HealthDegraded }},
	{"Loggable", func(n *Node) { n.Loggable = true }},
	{"Status", func(n *Node) { n.Status = "CrashLoopBackOff" }},
	{"Restarts", func(n *Node) { n.Restarts = 2 }},
	{"Host", func(n *Node) { n.Host = "node-2" }},
	{"ClusterIP", func(n *Node) { n.ClusterIP = "10.0.0.2" }},
	{"ExternalIP", func(n *Node) { n.ExternalIP = "203.0.113.7" }},
	{"Ports", func(n *Node) { n.Ports = []string{"443/TCP"} }},
	{"Selector", func(n *Node) { n.Selector = "app=api, tier=web" }},
	{"NodeSelector", func(n *Node) { n.NodeSelector = "kubernetes.io/os=linux" }},
	{"Routes", func(n *Node) { n.Routes = []string{"h/p → s:443"} }},
	{"NetPol", func(n *Node) { n.NetPol = []string{"Egress: deny all"} }},
	{"Taints", func(n *Node) { n.Taints = "node.kubernetes.io/unschedulable:NoSchedule" }},
	{"Scrapes", func(n *Node) { n.Scrapes = []string{":http/metrics every 30s"} }},
	{"Rules", func(n *Node) { n.Rules = []string{"pods: list"} }},
	{"RoleRef", func(n *Node) { n.RoleRef = "ClusterRole/admin" }},
	{"Subjects", func(n *Node) { n.Subjects = []string{"Group: b"} }},
	{"Images", func(n *Node) { n.Images = []string{"img:2"} }},
	{"ContainerStatuses", func(n *Node) {
		n.ContainerStatuses = []ContainerStatus{{Name: "app", Ready: false, State: "Waiting: CrashLoopBackOff"}}
	}},
	{"Endpoints", func(n *Node) { n.Endpoints = &Endpoints{Ready: 2, Total: 2} }},
	{"Labels", func(n *Node) { n.Labels = map[string]string{"app": "y"} }},
	{"OwnerUIDs", func(n *Node) { n.OwnerUIDs = []string{"o2"} }},
	{"Message", func(n *Node) { n.Message = "back-off 5m restarting" }},
	{"DataKeys", func(n *Node) { n.DataKeys = []string{"config.yaml (1.2 KiB)"} }},
	{"QuotaUsage", func(n *Node) { n.QuotaUsage = []string{"pods 3/10"} }},
	{"SecretType", func(n *Node) { n.SecretType = "kubernetes.io/tls" }},
	{"AccessModes", func(n *Node) { n.AccessModes = "RWO · standard" }},
	{"StorageClass", func(n *Node) { n.StorageClass = "fast-ssd" }},
	{"LastRun", func(n *Node) { n.LastRun = "2026-06-10T00:00:00Z" }},
	{"Active", func(n *Node) { n.Active = 1 }},
	{"Failed", func(n *Node) { n.Failed = 1 }},
	{"ScaleReplicas", func(n *Node) { n.ScaleReplicas = "3" }},
	{"ScaleRange", func(n *Node) { n.ScaleRange = "1–5" }},
	{"ScaleMetrics", func(n *Node) { n.ScaleMetrics = "cpu 80%/70%" }},
	{"AppDest", func(n *Node) { n.AppDest = "team-a @ prod-cluster" }},
	{"AppRevision", func(n *Node) { n.AppRevision = "abc1234" }},
	{"PDBPolicy", func(n *Node) { n.PDBPolicy = "minAvailable 1" }},
	{"Disruptions", func(n *Node) { n.Disruptions = "0 allowed" }},
	{"Provisioner", func(n *Node) { n.Provisioner = "ebs.csi.aws.com" }},
	{"ReclaimPolicy", func(n *Node) { n.ReclaimPolicy = "Retain" }},
	{"VolumeBinding", func(n *Node) { n.VolumeBinding = "WaitForFirstConsumer" }},
	{"Expandable", func(n *Node) { n.Expandable = true }},
	{"CertNames", func(n *Node) { n.CertNames = "*.shop.example.com" }},
	{"CertIssuer", func(n *Node) { n.CertIssuer = "letsencrypt-prod" }},
	{"CertExpiry", func(n *Node) { n.CertExpiry = "2026-09-01T00:00:00Z" }},
	{"IssuerConfig", func(n *Node) { n.IssuerConfig = "ACME · Let's Encrypt" }},
	{"Allocatable", func(n *Node) { c := int64(4000); n.Allocatable = &Resources{CPUMilli: &c} }},
	{"CapacityRes", func(n *Node) { c := int64(8000); n.CapacityRes = &Resources{CPUMilli: &c} }},
	{"Requests", func(n *Node) { c := int64(3000); n.Requests = &Resources{CPUMilli: &c} }},
	{"Limits", func(n *Node) { c := int64(6000); n.Limits = &Resources{CPUMilli: &c} }},
}

// Static/cosmetic fields intentionally excluded from nodeEqual (they never change for a live
// object, so a repaint would be wasted churn): changing them must keep the nodes equal.
var ignoredFieldCases = []struct {
	field string
	mut   func(n *Node)
}{
	{"CreatedAt", func(n *Node) { n.CreatedAt = "2030-01-01T00:00:00Z" }},
	{"Capacity", func(n *Node) { n.Capacity = "8 vCPU" }},
	{"Containers", func(n *Node) { n.Containers = []string{"app", "sidecar"} }},
	{"InitContainers", func(n *Node) { n.InitContainers = []string{"setup"} }}, // names-only display metadata; live state rides ContainerStatuses (Init: true)
}

func TestNodeEqualDetectsFieldChanges(t *testing.T) {
	base := baseNode()
	if !nodeEqual(base, base) {
		t.Fatal("a node must equal itself")
	}
	for _, tc := range changedFieldCases {
		n := base
		tc.mut(&n)
		if nodeEqual(base, n) {
			t.Errorf("nodeEqual ignored a change to %s — live updates to it would not repaint", tc.field)
		}
	}
	for _, tc := range ignoredFieldCases {
		n := base
		tc.mut(&n)
		if !nodeEqual(base, n) {
			t.Errorf("nodeEqual now reacts to %s — if intentional, update this test; else revert", tc.field)
		}
	}
}

// A Node field in NEITHER table above is undecided: nodeEqual may silently ignore it and the UI
// fed by it goes stale on live updates. Force every new field through an explicit decision.
func TestNodeEqualDecidesEveryField(t *testing.T) {
	decided := map[string]bool{}
	for _, tc := range changedFieldCases {
		decided[tc.field] = true
	}
	for _, tc := range ignoredFieldCases {
		decided[tc.field] = true
	}
	for _, f := range reflect.VisibleFields(reflect.TypeOf(Node{})) {
		if !decided[f.Name] {
			t.Errorf("Node.%s is in neither the changed nor the ignored field table — add it to one (and to nodeEqual if it must repaint)", f.Name)
		}
	}
}
