package graph

import "fmt"

// annotateServiceEndpoints writes endpoint readiness onto the matching Service nodes (keyed by node
// id, populated while selects edges are built) and flags trouble. A Service otherwise always reads
// Healthy, so one with no Ready backend — a selector matching nothing, or backends that are all down
// — would be an invisible outage; mark it Degraded with a status that says why. A Service with at
// least one Ready endpoint still serves traffic, so it stays calm and the drawer shows the ratio.
func annotateServiceEndpoints(nodes []Node, endpoints map[string]*Endpoints) {
	for i := range nodes {
		ep, ok := endpoints[nodes[i].ID]
		if !ok {
			continue
		}
		nodes[i].Endpoints = ep
		if ep.Ready > 0 {
			continue
		}
		nodes[i].Health = HealthDegraded
		if ep.Total == 0 {
			nodes[i].Status = "no endpoints"
		} else {
			nodes[i].Status = fmt.Sprintf("0/%d ready", ep.Total)
		}
	}
}
