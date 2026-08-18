#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
fixture_root="$(mktemp -d "${TMPDIR:-/tmp}/cchp-install-codex.XXXXXX")"
trap 'rm -rf "$fixture_root"' EXIT

fake_bin="$fixture_root/bin"
fixtures="$fixture_root/fixtures"
mkdir -p "$fake_bin" "$fixtures/wrapper/package/bin" \
  "$fixtures/platform/package/vendor/x86_64-unknown-linux-musl/bin" \
  "$fixtures/platform/package/vendor/x86_64-unknown-linux-musl/codex-resources" \
  "$fixtures/platform-arm64/package/vendor/aarch64-unknown-linux-musl/bin" \
  "$fixtures/platform-arm64/package/vendor/aarch64-unknown-linux-musl/codex-resources" \
  "$fixture_root/home" "$fixture_root/work"
real_node_bin="$(command -v node)"
[[ -x "$real_node_bin" ]]

cat >"$fixtures/wrapper/package/package.json" <<'EOF'
{
  "name": "@openai/codex",
  "version": "0.147.0",
  "bin": { "codex": "bin/codex.js" },
  "optionalDependencies": {
    "@openai/codex-linux-x64": "npm:@openai/codex@0.147.0-linux-x64",
    "@openai/codex-linux-arm64": "npm:@openai/codex@0.147.0-linux-arm64"
  }
}
EOF
cat >"$fixtures/wrapper/package/bin/codex.js" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf 'installed\n' >>"${FAKE_INSTALLED_MARKER:?}"
printf '%s\n' "${FAKE_INSTALLED_CODEX_VERSION:-codex-cli 0.147.0}"
EOF
chmod +x "$fixtures/wrapper/package/bin/codex.js"
cat >"$fixtures/platform/package/package.json" <<'EOF'
{"name":"@openai/codex","version":"0.147.0-linux-x64"}
EOF
cat >"$fixtures/platform-arm64/package/package.json" <<'EOF'
{"name":"@openai/codex","version":"0.147.0-linux-arm64"}
EOF
printf '#!/usr/bin/env bash\n[[ "$(basename "$0")" == "codex-linux-sandbox" ]] && printf "Linux sandbox helper\\n"\nexit 0\n' >"$fixtures/platform/package/vendor/x86_64-unknown-linux-musl/bin/codex"
printf '#!/usr/bin/env bash\n[[ "$(basename "$0")" == "codex-linux-sandbox" ]] && printf "Linux sandbox helper\\n"\nexit 0\n' >"$fixtures/platform-arm64/package/vendor/aarch64-unknown-linux-musl/bin/codex"
printf '#!/usr/bin/env bash\nexit 0\n' >"$fixtures/platform/package/vendor/x86_64-unknown-linux-musl/codex-resources/bwrap"
printf '#!/usr/bin/env bash\nexit 0\n' >"$fixtures/platform-arm64/package/vendor/aarch64-unknown-linux-musl/codex-resources/bwrap"
chmod +x \
  "$fixtures/platform/package/vendor/x86_64-unknown-linux-musl/bin/codex" \
  "$fixtures/platform-arm64/package/vendor/aarch64-unknown-linux-musl/bin/codex" \
  "$fixtures/platform/package/vendor/x86_64-unknown-linux-musl/codex-resources/bwrap" \
  "$fixtures/platform-arm64/package/vendor/aarch64-unknown-linux-musl/codex-resources/bwrap"
tar -czf "$fixtures/wrapper.tgz" -C "$fixtures/wrapper" package
tar -czf "$fixtures/platform.tgz" -C "$fixtures/platform" package
tar -czf "$fixtures/platform-arm64.tgz" -C "$fixtures/platform-arm64" package
cat >"$fixtures/wrapper-metadata.json" <<'EOF'
{"repository":{"url":"git+https://github.com/openai/codex.git","directory":"codex-cli"},"dist":{"integrity":"sha512-EQLEXecAG2ptxI7UpBMo2TR/ga5596/c/OsYF/0LoUDh5JANZ7IoGqlzBEWbuEVQ76JePIbtTW/ihCkp1a7Z3w==","attestations":{"provenance":{"predicateType":"https://slsa.dev/provenance/v1"}}}}
EOF
cat >"$fixtures/platform-metadata.json" <<'EOF'
{"repository":{"url":"git+https://github.com/openai/codex.git","directory":"codex-cli"},"dist":{"integrity":"sha512-0W9MBxPpWW0cSkNqrTDN2jR7rzzT7oNMhQY5446lT2Lw5cz5yhDTck4Va9rjkQEm+HlFzP/dmEMSZbXfJsINmw==","attestations":{"provenance":{"predicateType":"https://slsa.dev/provenance/v1"}}}}
EOF
cat >"$fixtures/platform-arm64-metadata.json" <<'EOF'
{"repository":{"url":"git+https://github.com/openai/codex.git","directory":"codex-cli"},"dist":{"integrity":"sha512-SLC1JXw2TYfr/c3HhrJubyyLelq7vTOLWVmiThFA+z0+WgzCPmaseJ/kzDD3Gge/TO7fCnnj7UcPmC0d2c8XAg==","attestations":{"provenance":{"predicateType":"https://slsa.dev/provenance/v1"}}}}
EOF
openssl ecparam -name prime256v1 -genkey -noout -out "$fixture_root/provenance-key.pem"
openssl req -new -x509 -key "$fixture_root/provenance-key.pem" -days 3650 \
  -subj '/O=sigstore.dev/CN=sigstore-intermediate' \
  -addext 'subjectAltName=URI:https://github.com/openai/codex/.github/workflows/rust-release.yml@refs/tags/rust-v0.147.0' \
  -out "$fixture_root/provenance-cert.pem"
cert_b64="$(openssl x509 -in "$fixture_root/provenance-cert.pem" -outform DER | base64 -w0)"
node - "$fixtures" "$fixture_root/provenance-key.pem" "$cert_b64" <<'NODE'
const fs = require("node:fs")
const crypto = require("node:crypto")
const [root, keyPath, certB64] = process.argv.slice(2)
const type = "application/vnd.in-toto+json"
const tag = "rust-v0.147.0"
const commit = "be6e8eac029b183056b7e4402879f15d2c85f61b"
const workflow = {
  repository: "https://github.com/openai/codex",
  path: ".github/workflows/rust-release.yml",
  ref: `refs/tags/${tag}`,
}
const pae = (payload) => {
  const t = Buffer.from(type)
  const p = Buffer.from(payload)
  return Buffer.concat([Buffer.from("DSSEv1 "), Buffer.from(String(t.length)), Buffer.from(" "), t, Buffer.from(" "), Buffer.from(String(p.length)), Buffer.from(" "), p])
}
function attestation(name, digest, mutate) {
  const statement = {
    _type: "https://in-toto.io/Statement/v1",
    subject: [{ name, digest: { sha512: digest } }],
    predicateType: "https://slsa.dev/provenance/v1",
    predicate: {
      buildDefinition: {
        buildType: "https://slsa-framework.github.io/github-actions-buildtypes/workflow/v1",
        externalParameters: { workflow },
        resolvedDependencies: [{ uri: `git+${workflow.repository}@${workflow.ref}`, digest: { gitCommit: commit } }],
      },
    },
  }
  mutate?.(statement)
  const payload = Buffer.from(JSON.stringify(statement))
  const sig = crypto.sign("sha256", pae(payload), fs.readFileSync(keyPath)).toString("base64")
  return {
    attestations: [{
      predicateType: "https://slsa.dev/provenance/v1",
      bundle: {
        mediaType: "application/vnd.dev.sigstore.bundle.v0.3+json",
        verificationMaterial: {
          certificate: { rawBytes: certB64 },
          tlogEntries: [{
            kindVersion: { kind: "dsse", version: "0.0.1" },
            logId: { keyId: "wNI9atQGlz+VWfO6LRygH4QUfY/8W4RFwiT5i5WRgB0=" },
            integratedTime: String(Math.floor(Date.now() / 1000)),
            canonicalizedBody: Buffer.from("fixture-body").toString("base64"),
            inclusionPromise: { signedEntryTimestamp: Buffer.from("fixture-set").toString("base64") },
            inclusionProof: {
              rootHash: Buffer.from("fixture-root").toString("base64"),
              treeSize: "1",
              hashes: [Buffer.from("fixture-hash").toString("base64")],
              checkpoint: { envelope: "fixture-checkpoint" },
            },
          }],
        },
        dsseEnvelope: { payload: payload.toString("base64"), payloadType: type, signatures: [{ sig }] },
      },
    }],
  }
}
fs.writeFileSync(`${root}/wrapper-attestation.json`, JSON.stringify(attestation(
  "pkg:npm/%40openai/codex@0.147.0",
  "1102c45de7001b6a6dc48ed4a41328d9347f81ae79f7afdcfceb1817fd0ba140e1e4900d67b2281aa97304459bb84550efa25e3c86ed4d6fe2842929d5aed9df",
)))
fs.writeFileSync(`${root}/platform-attestation.json`, JSON.stringify(attestation(
  "pkg:npm/%40openai/codex@0.147.0-linux-x64",
  "d16f4c0713e9596d1c4a436aad30cdda347baf3cd3ee834c850639e38ea54f62f0e5ccf9ca10d3724e156bdae3910126f87945ccffdd98431265b5df26c20d9b",
)))
fs.writeFileSync(`${root}/platform-arm64-attestation.json`, JSON.stringify(attestation(
  "pkg:npm/%40openai/codex@0.147.0-linux-arm64",
  "48b0b5257c364d87ebfdcdc786b26e6f2c8b7a5abbbd338b5959a24e1140fb3d3e5a0cc23e66ac789fe4cc30f71a07bf4ceedf0a79e3ed470f982d1dd9cf1702",
)))
const bad = JSON.parse(fs.readFileSync(`${root}/wrapper-attestation.json`, "utf8"))
bad.attestations[0].bundle.dsseEnvelope.signatures[0].sig = Buffer.from("invalid").toString("base64")
fs.writeFileSync(`${root}/bad-attestation.json`, JSON.stringify(bad))
const wrapperName = "pkg:npm/%40openai/codex@0.147.0"
const wrapperDigest = "1102c45de7001b6a6dc48ed4a41328d9347f81ae79f7afdcfceb1817fd0ba140e1e4900d67b2281aa97304459bb84550efa25e3c86ed4d6fe2842929d5aed9df"
const variants = {
  "wrong-subject-digest": (statement) => { statement.subject[0].digest.sha512 = "0".repeat(128) },
  "wrong-package": (statement) => { statement.subject[0].name = "pkg:npm/%40openai/other@0.147.0" },
  "wrong-repository": (statement) => { statement.predicate.buildDefinition.externalParameters.workflow.repository = "https://github.com/other/codex" },
  "wrong-workflow": (statement) => { statement.predicate.buildDefinition.externalParameters.workflow.path = ".github/workflows/other.yml" },
  "wrong-ref": (statement) => { statement.predicate.buildDefinition.externalParameters.workflow.ref = "refs/tags/rust-v0.145.0" },
  "wrong-commit": (statement) => { statement.predicate.buildDefinition.resolvedDependencies[0].digest.gitCommit = "0".repeat(40) },
}
for (const [name, mutate] of Object.entries(variants)) {
  fs.writeFileSync(`${root}/${name}-attestation.json`, JSON.stringify(attestation(wrapperName, wrapperDigest, mutate)))
}
const unsigned = JSON.parse(fs.readFileSync(`${root}/wrapper-attestation.json`, "utf8"))
unsigned.attestations[0].bundle.dsseEnvelope.signatures = []
fs.writeFileSync(`${root}/unsigned-attestation.json`, JSON.stringify(unsigned))
const missingRekor = JSON.parse(fs.readFileSync(`${root}/wrapper-attestation.json`, "utf8"))
delete missingRekor.attestations[0].bundle.verificationMaterial.tlogEntries[0].inclusionProof
fs.writeFileSync(`${root}/missing-rekor-attestation.json`, JSON.stringify(missingRekor))
NODE

cat >"$fake_bin/curl" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
output=""
url=""
while (($#)); do
  if [[ "$1" == "--output" ]]; then output="$2"; shift 2; continue; fi
  if [[ "$1" == https://* ]]; then url="$1"; fi
  shift
done
[[ -n "$output" && -n "$url" ]]
printf '%s\n' "$url" >>"${FAKE_CURL_TRACE:?}"
case "$url" in
  */@openai%2fcodex/0.147.0) cp "${FAKE_FIXTURES:?}/wrapper-metadata.json" "$output" ;;
  */@openai%2fcodex/0.147.0-linux-x64) cp "${FAKE_FIXTURES:?}/platform-metadata.json" "$output" ;;
  */@openai%2fcodex/0.147.0-linux-arm64) cp "${FAKE_FIXTURES:?}/platform-arm64-metadata.json" "$output" ;;
  *attestations/@openai%2fcodex@0.147.0)
    if [[ "${FAKE_BAD_ATTESTATION:-0}" == 1 ]]; then
      cp "${FAKE_FIXTURES:?}/bad-attestation.json" "$output"
    elif [[ -n "${FAKE_ATTESTATION_VARIANT:-}" ]]; then
      cp "${FAKE_FIXTURES:?}/${FAKE_ATTESTATION_VARIANT}-attestation.json" "$output"
    else
      cp "${FAKE_FIXTURES:?}/wrapper-attestation.json" "$output"
    fi
    ;;
  *attestations/@openai%2fcodex@0.147.0-linux-x64) cp "${FAKE_FIXTURES:?}/platform-attestation.json" "$output" ;;
  *attestations/@openai%2fcodex@0.147.0-linux-arm64) cp "${FAKE_FIXTURES:?}/platform-arm64-attestation.json" "$output" ;;
  *codex-0.147.0.tgz) cp "${FAKE_FIXTURES:?}/wrapper.tgz" "$output" ;;
  *codex-0.147.0-linux-x64.tgz) cp "${FAKE_FIXTURES:?}/platform.tgz" "$output" ;;
  *codex-0.147.0-linux-arm64.tgz) cp "${FAKE_FIXTURES:?}/platform-arm64.tgz" "$output" ;;
  *) exit 91 ;;
esac
EOF

cat >"$fake_bin/sha256sum" <<'EOF'
#!/usr/bin/env bash
printf '%s  %s\n' "${FAKE_WRAPPER_SHA:-d28b4fd4bd9f07ea71083d0cc40c579595cebbd4c10bc8ca98a6d385432e7255}" "$1"
EOF

cat >"$fake_bin/sha512sum" <<'EOF'
#!/usr/bin/env bash
case "$1" in
  *codex-0.147.0-linux-x64.tgz) printf '%s  %s\n' "${FAKE_PLATFORM_SHA:-d16f4c0713e9596d1c4a436aad30cdda347baf3cd3ee834c850639e38ea54f62f0e5ccf9ca10d3724e156bdae3910126f87945ccffdd98431265b5df26c20d9b}" "$1" ;;
  *codex-0.147.0-linux-arm64.tgz) printf '%s  %s\n' "${FAKE_PLATFORM_SHA:-48b0b5257c364d87ebfdcdc786b26e6f2c8b7a5abbbd338b5959a24e1140fb3d3e5a0cc23e66ac789fe4cc30f71a07bf4ceedf0a79e3ed470f982d1dd9cf1702}" "$1" ;;
  *codex-0.147.0.tgz) printf '%s  %s\n' "1102c45de7001b6a6dc48ed4a41328d9347f81ae79f7afdcfceb1817fd0ba140e1e4900d67b2281aa97304459bb84550efa25e3c86ed4d6fe2842929d5aed9df" "$1" ;;
  *) exit 2 ;;
esac
EOF

cat >"$fake_bin/uname" <<'EOF'
#!/usr/bin/env bash
case "${1:-}" in
  -s) printf '%s\n' "${FAKE_UNAME_S:-Linux}" ;;
  -m) printf '%s\n' "${FAKE_UNAME_M:-x86_64}" ;;
  *) exit 2 ;;
esac
EOF

cat >"$fake_bin/codex" <<'EOF'
#!/usr/bin/env bash
printf 'poison\n' >>"${FAKE_POISON_MARKER:?}"
printf 'codex-cli 0.147.0\n'
EOF

cat >"$fake_bin/npm" <<'EOF'
#!/usr/bin/env bash
printf 'npm-used\n' >>"${FAKE_NPM_MARKER:?}"
exit 99
EOF
cat >"$fake_bin/bun" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >>"${FAKE_SIGSTORE_TRACE:?}"
outfile=""
while (($#)); do
  if [[ "$1" == "--outfile" ]]; then outfile="$2"; shift 2; continue; fi
  shift
done
[[ -n "$outfile" ]]
printf 'process.exit(Number(process.env.FAKE_SIGSTORE_STATUS || 0))\n' >"$outfile"
EOF
chmod +x "$fake_bin"/*
ln -s "$real_node_bin" "$fake_bin/node"
[[ "$(PATH="$fake_bin:/usr/bin:/bin" command -v node)" == "$fake_bin/node" ]]

run_install() {
  env \
    HOME="$fixture_root/home" \
    BOT_WORKDIR="$fixture_root/work" \
    GITHUB_ENV="$fixture_root/github-env" \
    GITHUB_PATH="$fixture_root/github-path" \
    PATH="$fake_bin:/usr/bin:/bin" \
    FAKE_FIXTURES="$fixtures" \
    FAKE_CURL_TRACE="$fixture_root/curl.trace" \
    FAKE_INSTALLED_MARKER="$fixture_root/installed.marker" \
    FAKE_POISON_MARKER="$fixture_root/poison.marker" \
    FAKE_NPM_MARKER="$fixture_root/npm.marker" \
    FAKE_SIGSTORE_TRACE="$fixture_root/sigstore.trace" \
    "$@" \
    bash "$repo_root/scripts/install-codex.sh"
}

success_log="$fixture_root/success.log"
if ! run_install >"$success_log" 2>&1; then
  sed -n '1,200p' "$success_log" >&2
  exit 1
fi
codex_bin="$fixture_root/work/codex-install/npm/bin/codex"
grep -F '[codex-install] package=@openai/codex version=0.147.0 source_tag=rust-v0.147.0 source_commit=be6e8eac029b183056b7e4402879f15d2c85f61b' "$success_log" >/dev/null
grep -F '[codex-install] target=linux-x64 platform_package=@openai/codex@0.147.0-linux-x64' "$success_log" >/dev/null
grep -F "[codex-install] codex-cli 0.147.0 ($codex_bin)" "$success_log" >/dev/null
grep -Fx "CODEX_BIN=$codex_bin" "$fixture_root/github-env" >/dev/null
grep -Fx "$fixture_root/work/codex-install/npm/bin" "$fixture_root/github-path" >/dev/null
[[ "$(wc -l <"$fixture_root/curl.trace")" -eq 6 ]]
[[ -x "$codex_bin" ]]
[[ -x "$fixture_root/work/codex-install/npm/bin/bwrap" ]]
[[ -x "$fixture_root/work/codex-install/npm/bin/codex-linux-sandbox" ]]
[[ "$("$fixture_root/work/codex-install/npm/bin/codex-linux-sandbox" --help)" == "Linux sandbox helper" ]]
[[ "$(readlink -f "$fixture_root/work/codex-install/npm/bin/codex-linux-sandbox")" == \
  "$fixture_root/work/codex-install/npm/lib/node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex" ]]
[[ -f "$fixture_root/work/codex-install/npm/lib/node_modules/@openai/codex-linux-x64/package.json" ]]
[[ -s "$fixture_root/installed.marker" ]]
[[ ! -e "$fixture_root/poison.marker" ]]
[[ ! -e "$fixture_root/npm.marker" ]]
[[ "$(wc -l <"$fixture_root/sigstore.trace")" -eq 1 ]]
grep -F 'verify-codex-sigstore.ts' "$fixture_root/sigstore.trace" >/dev/null

: >"$fixture_root/curl.trace"
arm_log="$fixture_root/arm-success.log"
if ! FAKE_UNAME_M=aarch64 run_install >"$arm_log" 2>&1; then
  sed -n '1,200p' "$arm_log" >&2
  exit 1
fi
grep -F '[codex-install] target=linux-arm64 platform_package=@openai/codex@0.147.0-linux-arm64' "$arm_log" >/dev/null
[[ "$(wc -l <"$fixture_root/curl.trace")" -eq 6 ]]
[[ -f "$fixture_root/work/codex-install/npm/lib/node_modules/@openai/codex-linux-arm64/package.json" ]]
[[ "$("$fixture_root/work/codex-install/npm/bin/codex-linux-sandbox" --help)" == "Linux sandbox helper" ]]
[[ "$(readlink -f "$fixture_root/work/codex-install/npm/bin/codex-linux-sandbox")" == \
  "$fixture_root/work/codex-install/npm/lib/node_modules/@openai/codex-linux-arm64/vendor/aarch64-unknown-linux-musl/bin/codex" ]]

: >"$fixture_root/github-env"
: >"$fixture_root/curl.trace"
relative_log="$fixture_root/relative-success.log"
if ! (cd "$fixture_root" && run_install BOT_WORKDIR=relative >"$relative_log" 2>&1); then
  sed -n '1,200p' "$relative_log" >&2
  exit 1
fi
grep -Fx "CODEX_BIN=$fixture_root/relative/codex-install/npm/bin/codex" "$fixture_root/github-env" >/dev/null

set +e
FAKE_WRAPPER_SHA=deadbeef run_install >"$fixture_root/wrapper-sha-failure.log" 2>&1
wrapper_status=$?
FAKE_PLATFORM_SHA=deadbeef run_install >"$fixture_root/platform-sha-failure.log" 2>&1
platform_status=$?
FAKE_INSTALLED_CODEX_VERSION='codex-cli 0.147.0-malicious' run_install >"$fixture_root/version-failure.log" 2>&1
version_status=$?
FAKE_UNAME_M=s390x run_install >"$fixture_root/target-failure.log" 2>&1
target_status=$?
FAKE_BAD_ATTESTATION=1 run_install >"$fixture_root/provenance-failure.log" 2>&1
provenance_status=$?
FAKE_SIGSTORE_STATUS=17 run_install FAKE_SIGSTORE_TRACE="$fixture_root/sigstore-failure.trace" >"$fixture_root/sigstore-failure.log" 2>&1
sigstore_status=$?
set -e

[[ "$wrapper_status" -eq 2 ]]
[[ "$platform_status" -eq 2 ]]
[[ "$version_status" -eq 2 ]]
[[ "$target_status" -eq 2 ]]
[[ "$provenance_status" -eq 2 ]]
[[ "$sigstore_status" -eq 2 ]]
grep -F 'wrapper SHA256 mismatch' "$fixture_root/wrapper-sha-failure.log" >/dev/null
grep -F 'platform SHA512 mismatch' "$fixture_root/platform-sha-failure.log" >/dev/null
grep -F 'version mismatch' "$fixture_root/version-failure.log" >/dev/null
grep -F 'unsupported Codex target' "$fixture_root/target-failure.log" >/dev/null
grep -F 'source provenance validation failed' "$fixture_root/provenance-failure.log" >/dev/null
grep -F 'Sigstore trust-root verification failed' "$fixture_root/sigstore-failure.log" >/dev/null
[[ "$(wc -l <"$fixture_root/sigstore-failure.trace")" -eq 1 ]]

for variant in unsigned missing-rekor wrong-subject-digest wrong-package wrong-repository wrong-workflow wrong-ref wrong-commit; do
  trace="$fixture_root/${variant}.trace"
  log="$fixture_root/${variant}.log"
  set +e
  run_install FAKE_CURL_TRACE="$trace" FAKE_ATTESTATION_VARIANT="$variant" >"$log" 2>&1
  status=$?
  set -e
  [[ "$status" -eq 2 ]]
  grep -F 'source provenance validation failed' "$log" >/dev/null
  [[ "$(wc -l <"$trace")" -eq 4 ]]
  if grep -F '.tgz' "$trace" >/dev/null; then
    printf '[install-codex-test] provenance failure downloaded a tarball for %s\n' "$variant" >&2
    exit 1
  fi
done

if grep -E 'Authorization:|Bearer |GH_TOKEN|CCHP_BOT_PROVIDER_KEYS|CCHP_APP_PRIVATE_KEY' "$success_log"; then
  printf '[install-codex-test] provenance output leaked a credential marker\n' >&2
  exit 1
fi

printf '[install-codex-test] passed\n'
