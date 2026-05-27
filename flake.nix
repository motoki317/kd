{
  description = "kd — web-served Kubernetes dashboard (Go server + Solid.js client)";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = import nixpkgs { inherit system; };
      in
      {
        devShells.default = pkgs.mkShell {
          packages = with pkgs; [
            go_1_26
            gopls
            golangci-lint
            nodejs_24
            just
            kubectl
          ];
        };
      });
}
