#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
fixture_root="$(mktemp -d "${TMPDIR:-/tmp}/cchp-install-codex.XXXXXX")"
trap 'rm -rf "$fixture_root"' EXIT

fake_bin="$fixture_root/bin"
fixtures="$fixture_root/fixtures"
mkdir -p "$fake_bin" "$fixtures/wrapper/package/bin" "$fixtures/platform/package/bin" "$fixtures/platform-arm64/package/bin" "$fixture_root/home" "$fixture_root/work"

cat >"$fixtures/wrapper/package/package.json" <<'EOF'
{
  "name": "@openai/codex",
  "version": "0.146.0",
  "bin": { "codex": "bin/codex.js" },
  "optionalDependencies": {
    "@openai/codex-linux-x64": "npm:@openai/codex@0.146.0-linux-x64",
    "@openai/codex-linux-arm64": "npm:@openai/codex@0.146.0-linux-arm64"
  }
}
EOF
cat >"$fixtures/wrapper/package/bin/codex.js" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf 'installed\n' >>"${FAKE_INSTALLED_MARKER:?}"
printf '%s\n' "${FAKE_INSTALLED_CODEX_VERSION:-codex-cli 0.146.0}"
EOF
chmod +x "$fixtures/wrapper/package/bin/codex.js"
cat >"$fixtures/platform/package/package.json" <<'EOF'
{"name":"@openai/codex","version":"0.146.0-linux-x64"}
EOF
cat >"$fixtures/platform-arm64/package/package.json" <<'EOF'
{"name":"@openai/codex","version":"0.146.0-linux-arm64"}
EOF
printf 'verified native payload\n' >"$fixtures/platform/package/bin/codex"
printf 'verified arm native payload\n' >"$fixtures/platform-arm64/package/bin/codex"
tar -czf "$fixtures/wrapper.tgz" -C "$fixtures/wrapper" package
tar -czf "$fixtures/platform.tgz" -C "$fixtures/platform" package
tar -czf "$fixtures/platform-arm64.tgz" -C "$fixtures/platform-arm64" package
cat >"$fixtures/wrapper-metadata.json" <<'EOF'
{"repository":{"url":"git+https://github.com/openai/codex.git","directory":"codex-cli"},"dist":{"integrity":"sha512-yG3sPWNda/2YAIQIDq9MrrjoCTIQ7rxYM5IasrG3VBcuhCLTkgeg/JzqmJq1V98RE4MJ5jCxDXXQlOjrditFRw==","attestations":{"provenance":{"predicateType":"https://slsa.dev/provenance/v1"}}}}
EOF
cat >"$fixtures/platform-metadata.json" <<'EOF'
{"repository":{"url":"git+https://github.com/openai/codex.git","directory":"codex-cli"},"dist":{"integrity":"sha512-fswvyGprAPCMiOEue/7MKMk7pCjh9kZIJfJX5i9atmfnmGYbYCcUhZsEH9LEP0+0t5xyPqDbfNXY7NSxIVuXxA==","attestations":{"provenance":{"predicateType":"https://slsa.dev/provenance/v1"}}}}
EOF
cat >"$fixtures/platform-arm64-metadata.json" <<'EOF'
{"repository":{"url":"git+https://github.com/openai/codex.git","directory":"codex-cli"},"dist":{"integrity":"sha512-qiYDxkkEFnXG7joadJW6Q+XcgyDXCpGdpa9nk/c+i0gEomur1j7bHvx12NfWWCF/y8Tqri6ay+FLuC2MjdehtA==","attestations":{"provenance":{"predicateType":"https://slsa.dev/provenance/v1"}}}}
EOF
openssl ecparam -name prime256v1 -genkey -noout -out "$fixture_root/provenance-key.pem"
openssl req -new -x509 -key "$fixture_root/provenance-key.pem" -days 3650 \
  -subj '/O=sigstore.dev/CN=sigstore-intermediate' \
  -addext 'subjectAltName=URI:https://github.com/openai/codex/.github/workflows/rust-release.yml@refs/tags/rust-v0.146.0' \
  -out "$fixture_root/provenance-cert.pem"
cert_b64="$(openssl x509 -in "$fixture_root/provenance-cert.pem" -outform DER | base64 -w0)"
node - "$fixtures" "$fixture_root/provenance-key.pem" "$cert_b64" <<'NODE'
const fs = require("node:fs")
const crypto = require("node:crypto")
const [root, keyPath, certB64] = process.argv.slice(2)
const type = "application/vnd.in-toto+json"
const tag = "rust-v0.146.0"
const commit = "e363b08c9175ac1cbe5893615dd2cb9ddf95043b"
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
  "pkg:npm/%40openai/codex@0.146.0",
  "c86dec3d635d6bfd980084080eaf4caeb8e8093210eebc5833921ab2b1b754172e8422d39207a0fc9cea989ab557df11138309e630b10d75d094e8eb762b4547",
)))
fs.writeFileSync(`${root}/platform-attestation.json`, JSON.stringify(attestation(
  "pkg:npm/%40openai/codex@0.146.0-linux-x64",
  "7ecc2fc86a6b00f08c88e12e7bfecc28c93ba428e1f6464825f257e62f5ab667e798661b602714859b041fd2c43f4fb4b79c723ea0db7cd5d8ecd4b1215b97c4",
)))
fs.writeFileSync(`${root}/platform-arm64-attestation.json`, JSON.stringify(attestation(
  "pkg:npm/%40openai/codex@0.146.0-linux-arm64",
  "aa2603c649041675c6ee3a1a7495ba43e5dc8320d70a919da5af6793f73e8b4804a26babd63edb1efc75d8d7d658217fcbc4eaae2e9acbe14bb82d8c8dd7a1b4",
)))
const bad = JSON.parse(fs.readFileSync(`${root}/wrapper-attestation.json`, "utf8"))
bad.attestations[0].bundle.dsseEnvelope.signatures[0].sig = Buffer.from("invalid").toString("base64")
fs.writeFileSync(`${root}/bad-attestation.json`, JSON.stringify(bad))
const wrapperName = "pkg:npm/%40openai/codex@0.146.0"
const wrapperDigest = "c86dec3d635d6bfd980084080eaf4caeb8e8093210eebc5833921ab2b1b754172e8422d39207a0fc9cea989ab557df11138309e630b10d75d094e8eb762b4547"
const variants = {
  "wrong-subject-digest": (statement) => { statement.subject[0].digest.sha512 = "0".repeat(128) },
  "wrong-package": (statement) => { statement.subject[0].name = "pkg:npm/%40openai/other@0.146.0" },
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
  */@openai%2fcodex/0.146.0) cp "${FAKE_FIXTURES:?}/wrapper-metadata.json" "$output" ;;
  */@openai%2fcodex/0.146.0-linux-x64) cp "${FAKE_FIXTURES:?}/platform-metadata.json" "$output" ;;
  */@openai%2fcodex/0.146.0-linux-arm64) cp "${FAKE_FIXTURES:?}/platform-arm64-metadata.json" "$output" ;;
  *attestations/@openai%2fcodex@0.146.0)
    if [[ "${FAKE_BAD_ATTESTATION:-0}" == 1 ]]; then
      cp "${FAKE_FIXTURES:?}/bad-attestation.json" "$output"
    elif [[ -n "${FAKE_ATTESTATION_VARIANT:-}" ]]; then
      cp "${FAKE_FIXTURES:?}/${FAKE_ATTESTATION_VARIANT}-attestation.json" "$output"
    else
      cp "${FAKE_FIXTURES:?}/wrapper-attestation.json" "$output"
    fi
    ;;
  *attestations/@openai%2fcodex@0.146.0-linux-x64) cp "${FAKE_FIXTURES:?}/platform-attestation.json" "$output" ;;
  *attestations/@openai%2fcodex@0.146.0-linux-arm64) cp "${FAKE_FIXTURES:?}/platform-arm64-attestation.json" "$output" ;;
  *codex-0.146.0.tgz) cp "${FAKE_FIXTURES:?}/wrapper.tgz" "$output" ;;
  *codex-0.146.0-linux-x64.tgz) cp "${FAKE_FIXTURES:?}/platform.tgz" "$output" ;;
  *codex-0.146.0-linux-arm64.tgz) cp "${FAKE_FIXTURES:?}/platform-arm64.tgz" "$output" ;;
  *) exit 91 ;;
esac
EOF

cat >"$fake_bin/sha256sum" <<'EOF'
#!/usr/bin/env bash
printf '%s  %s\n' "${FAKE_WRAPPER_SHA:-8050af14387e23b8d46026f023f0c1d33a2eefb39267bf36abe8cec2cec17b49}" "$1"
EOF

cat >"$fake_bin/sha512sum" <<'EOF'
#!/usr/bin/env bash
case "$1" in
  *codex-0.146.0-linux-x64.tgz) printf '%s  %s\n' "${FAKE_PLATFORM_SHA:-7ecc2fc86a6b00f08c88e12e7bfecc28c93ba428e1f6464825f257e62f5ab667e798661b602714859b041fd2c43f4fb4b79c723ea0db7cd5d8ecd4b1215b97c4}" "$1" ;;
  *codex-0.146.0-linux-arm64.tgz) printf '%s  %s\n' "${FAKE_PLATFORM_SHA:-aa2603c649041675c6ee3a1a7495ba43e5dc8320d70a919da5af6793f73e8b4804a26babd63edb1efc75d8d7d658217fcbc4eaae2e9acbe14bb82d8c8dd7a1b4}" "$1" ;;
  *codex-0.146.0.tgz) printf '%s  %s\n' "c86dec3d635d6bfd980084080eaf4caeb8e8093210eebc5833921ab2b1b754172e8422d39207a0fc9cea989ab557df11138309e630b10d75d094e8eb762b4547" "$1" ;;
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
printf 'codex-cli 0.146.0\n'
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

run_install() {
  env \
    HOME="$fixture_root/home" \
    BOT_WORKDIR="$fixture_root/work" \
    GITHUB_ENV="$fixture_root/github-env" \
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
grep -F '[codex-install] package=@openai/codex version=0.146.0 source_tag=rust-v0.146.0 source_commit=e363b08c9175ac1cbe5893615dd2cb9ddf95043b' "$success_log" >/dev/null
grep -F '[codex-install] target=linux-x64 platform_package=@openai/codex@0.146.0-linux-x64' "$success_log" >/dev/null
grep -F "[codex-install] codex-cli 0.146.0 ($codex_bin)" "$success_log" >/dev/null
grep -Fx "CODEX_BIN=$codex_bin" "$fixture_root/github-env" >/dev/null
[[ "$(wc -l <"$fixture_root/curl.trace")" -eq 6 ]]
[[ -x "$codex_bin" ]]
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
grep -F '[codex-install] target=linux-arm64 platform_package=@openai/codex@0.146.0-linux-arm64' "$arm_log" >/dev/null
[[ "$(wc -l <"$fixture_root/curl.trace")" -eq 6 ]]
[[ -f "$fixture_root/work/codex-install/npm/lib/node_modules/@openai/codex-linux-arm64/package.json" ]]

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
FAKE_INSTALLED_CODEX_VERSION='codex-cli 0.146.0-malicious' run_install >"$fixture_root/version-failure.log" 2>&1
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
