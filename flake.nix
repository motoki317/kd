{
  description = "kd — web-served Kubernetes dashboard (Go server + Solid.js client)";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
    git-hooks = {
      url = "github:cachix/git-hooks.nix";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs = { self, nixpkgs, flake-utils, git-hooks }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = import nixpkgs { inherit system; };

        # go.mod pins go 1.26.x; build with the matching toolchain.
        buildGoModule = pkgs.buildGoModule.override { go = pkgs.go_1_26; };

        version = self.shortRev or self.dirtyShortRev or "dev";

        # The Solid client built by `vite build`. vite emits into
        # ../internal/server/webdist (see web/vite.config.ts) so the Go server can
        # go:embed it; here we capture that output as its own derivation so the Go
        # build stays a pure consumer of pre-built assets.
        web = pkgs.buildNpmPackage {
          pname = "kd-web";
          inherit version;
          src = ./web;
          npmDepsHash = "sha256-BIweJS/4FkpqgoMl16GTz95rcSlpr8REb1SBcPf9giQ=";
          nodejs = pkgs.nodejs_24;
          installPhase = ''
            runHook preInstall
            cp -r ../internal/server/webdist $out
            runHook postInstall
          '';
        };

        # Git-hook entrypoints. They delegate to the justfile recipes (the single
        # source of truth for the project's commands) and only supply the toolchain
        # on PATH. GOTOOLCHAIN=local pins go to the nix-provided go_1_26 (which
        # satisfies go.mod) so no toolchain is fetched at hook time.
        preCommitHook = pkgs.writeShellApplication {
          name = "kd-pre-commit";
          runtimeInputs = [ pkgs.go_1_26 pkgs.nodejs_24 pkgs.just ];
          text = ''
            export GOTOOLCHAIN=local
            just pre-commit
          '';
        };
        # The flake build uses the system nix already on PATH; only `just` is supplied.
        nixBuildHook = pkgs.writeShellApplication {
          name = "kd-nix-build";
          runtimeInputs = [ pkgs.just ];
          text = "just nix-build";
        };

        # Local-only git hooks. Not exposed under `checks`: the build/test hooks need
        # the working tree's go-module and node_modules caches (and nix-in-nix for the
        # flake build), none of which exist in the pure `nix flake check` sandbox.
        preCommitCheck = git-hooks.lib.${system}.run {
          src = ./.;
          hooks = {
            # Every commit must compile, build, embed and pass tests (~2–10s warm).
            kd-pre-commit = {
              enable = true;
              name = "kd build + checks (just build, gofmt, vet, go+web tests)";
              entry = pkgs.lib.getExe preCommitHook;
              language = "system";
              pass_filenames = false;
            };
            # Validate the Nix path (stale vendorHash / npmDepsHash or a flake error)
            # only when a commit touches a dependency/flake file — the only changes
            # that can break it. ~60–95s, so it stays off the per-commit hot path.
            kd-nix-build = {
              enable = true;
              name = "nix build .#kd (only on go.mod/go.sum/package-lock/vite.config/flake changes)";
              entry = pkgs.lib.getExe nixBuildHook;
              language = "system";
              pass_filenames = false;
              files = "(^go\\.(mod|sum)$|^web/package-lock\\.json$|^web/vite\\.config\\.ts$|^flake\\.(nix|lock)$)";
            };
          };
        };
      in
      {
        packages = {
          default = self.packages.${system}.kd;

          kd = buildGoModule {
            pname = "kd";
            inherit version;
            src = ./.;
            vendorHash = "sha256-BEDej9URMynyirV1Bm0xoIxZhU5+9llcBCHmtpMnUpg=";
            subPackages = [ "cmd/kd" ];
            tags = [ "embed_web" ];
            ldflags = [ "-s" "-w" ];
            env.CGO_ENABLED = 0;

            # webdist is gitignored, so the flake source omits it; populate the
            # go:embed target from the pre-built client before compiling.
            preBuild = ''
              mkdir -p internal/server/webdist
              cp -r ${web}/. internal/server/webdist/
            '';

            meta = {
              description = "Web-served Kubernetes dashboard";
              homepage = "https://github.com/motoki317/kd";
              license = pkgs.lib.licenses.mit;
              mainProgram = "kd";
            };
          };
        };

        apps.default = {
          type = "app";
          program = "${self.packages.${system}.kd}/bin/kd";
        };

        devShells.default = pkgs.mkShell {
          inherit (preCommitCheck) shellHook;
          packages = (with pkgs; [
            go_1_26
            gopls
            golangci-lint
            nodejs_24
            just
            kubectl
          ]) ++ preCommitCheck.enabledPackages;
        };
      });
}
