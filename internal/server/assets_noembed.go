//go:build !embed_web

package server

import "io/fs"

// clientAssets reports no embedded client in the default build, so the package compiles without
// a prior client build (tests, `go build ./...`, CI). The release build uses the embed_web tag.
func clientAssets() (fs.FS, bool) { return nil, false }
