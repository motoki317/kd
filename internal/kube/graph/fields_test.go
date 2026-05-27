package graph

import (
	"slices"
	"testing"

	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/resource"
	"k8s.io/apimachinery/pkg/util/intstr"
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

func TestServicePorts(t *testing.T) {
	svc := &corev1.Service{Spec: corev1.ServiceSpec{Ports: []corev1.ServicePort{
		{Name: "https", Port: 443, TargetPort: intstr.FromInt32(8443), Protocol: corev1.ProtocolTCP},
		{Port: 80, NodePort: 30080}, // unset protocol defaults to TCP; nodePort surfaced
		{Port: 9090},                // target == port and no nodePort: just "9090/TCP"
		{Name: "metrics", Port: 53, TargetPort: intstr.FromString("dns"), Protocol: corev1.ProtocolUDP},
	}}}
	want := []string{"https 443→8443/TCP", "80:30080/TCP", "9090/TCP", "metrics 53→dns/UDP"}
	if got := servicePorts(svc); !slices.Equal(got, want) {
		t.Errorf("servicePorts = %v, want %v", got, want)
	}
	if got := servicePorts(&corev1.Pod{}); got != nil {
		t.Errorf("servicePorts(non-service) = %v, want nil", got)
	}
}

func TestServiceClusterIP(t *testing.T) {
	tests := []struct {
		name string
		svc  *corev1.Service
		want string
	}{
		{"clusterIP", &corev1.Service{Spec: corev1.ServiceSpec{ClusterIP: "10.96.0.1"}}, "10.96.0.1"},
		{"headless", &corev1.Service{Spec: corev1.ServiceSpec{ClusterIP: corev1.ClusterIPNone}}, "headless"},
		{"unassigned", &corev1.Service{Spec: corev1.ServiceSpec{}}, ""},
		{"externalName", &corev1.Service{Spec: corev1.ServiceSpec{
			Type: corev1.ServiceTypeExternalName, ExternalName: "db.example.com",
		}}, "db.example.com"},
	}
	for _, tt := range tests {
		if got := serviceClusterIP(tt.svc); got != tt.want {
			t.Errorf("serviceClusterIP(%s) = %q, want %q", tt.name, got, tt.want)
		}
	}
	if got := serviceClusterIP(&corev1.Pod{}); got != "" {
		t.Errorf("serviceClusterIP(non-service) = %q, want empty", got)
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
