package api

import "testing"

// parseTail maps the ?tail= query value to an optional line count. A bad or negative value must read
// as "unset" (nil) — same as omitting it — so a malformed client param falls back to the server
// default rather than erroring or streaming a negative tail.
func TestParseTail(t *testing.T) {
	cases := []struct {
		in   string
		want *int64
	}{
		{"", nil},        // omitted → default
		{"100", ptr(100)}, // explicit count
		{"0", ptr(0)},     // zero is valid (tail nothing, then follow)
		{"-5", nil},       // negative → unset, not a negative tail
		{"abc", nil},      // non-numeric → unset
	}
	for _, c := range cases {
		got := parseTail(c.in)
		switch {
		case c.want == nil && got != nil:
			t.Errorf("parseTail(%q) = %d, want nil", c.in, *got)
		case c.want != nil && got == nil:
			t.Errorf("parseTail(%q) = nil, want %d", c.in, *c.want)
		case c.want != nil && got != nil && *got != *c.want:
			t.Errorf("parseTail(%q) = %d, want %d", c.in, *got, *c.want)
		}
	}
}

func ptr(n int64) *int64 { return &n }
