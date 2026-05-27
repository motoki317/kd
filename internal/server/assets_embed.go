//go:build embed_web

package server

import (
	"embed"
	"io/fs"
)

// webdist holds the built client, populated by `just build-web` before a tagged build.
//
//go:embed all:webdist
var webdist embed.FS

// clientAssets returns the embedded client rooted at the webdist directory.
func clientAssets() (fs.FS, bool) {
	sub, err := fs.Sub(webdist, "webdist")
	if err != nil {
		return nil, false
	}
	return sub, true
}
