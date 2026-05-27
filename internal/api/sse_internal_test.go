package api

import "testing"

func TestSplitLogTimestamp(t *testing.T) {
	tests := map[string]struct {
		line     string
		wantTime string
		wantMsg  string
	}{
		"rfc3339nano prefix is split off": {
			line:     "2026-05-28T01:02:03.123456789Z hello world",
			wantTime: "2026-05-28T01:02:03.123456789Z",
			wantMsg:  "hello world",
		},
		"timezone offset prefix is split off": {
			line:     "2026-05-28T10:02:03+09:00 こんにちは",
			wantTime: "2026-05-28T10:02:03+09:00",
			wantMsg:  "こんにちは",
		},
		"a line without a timestamp is left intact": {
			line:    "plain log line without timestamp",
			wantMsg: "plain log line without timestamp",
		},
		"a non-timestamp first token is not mistaken for one": {
			line:    "INFO starting up",
			wantMsg: "INFO starting up",
		},
		"a line with no space is left intact": {
			line:    "single-token",
			wantMsg: "single-token",
		},
	}
	for name, tc := range tests {
		t.Run(name, func(t *testing.T) {
			ts, msg := splitLogTimestamp(tc.line)
			if ts != tc.wantTime || msg != tc.wantMsg {
				t.Errorf("splitLogTimestamp(%q) = (%q, %q), want (%q, %q)", tc.line, ts, msg, tc.wantTime, tc.wantMsg)
			}
		})
	}
}
