#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"

# Engine-owned Codex pin. Caller variables/secrets never select or override it.
CODEX_PACKAGE="@openai/codex"
CODEX_VERSION="0.146.0"
CODEX_SOURCE_TAG="rust-v0.146.0"
CODEX_SOURCE_COMMIT="e363b08c9175ac1cbe5893615dd2cb9ddf95043b"
EXPECTED_WRAPPER_SHA256="8050af14387e23b8d46026f023f0c1d33a2eefb39267bf36abe8cec2cec17b49"
EXPECTED_WRAPPER_SHA512="c86dec3d635d6bfd980084080eaf4caeb8e8093210eebc5833921ab2b1b754172e8422d39207a0fc9cea989ab557df11138309e630b10d75d094e8eb762b4547"
WRAPPER_REGISTRY_INTEGRITY="sha512-yG3sPWNda/2YAIQIDq9MrrjoCTIQ7rxYM5IasrG3VBcuhCLTkgeg/JzqmJq1V98RE4MJ5jCxDXXQlOjrditFRw=="

case "$(uname -s):$(uname -m)" in
  Linux:x86_64|Linux:amd64)
    CODEX_TARGET="linux-x64"
    EXPECTED_PLATFORM_SHA512="7ecc2fc86a6b00f08c88e12e7bfecc28c93ba428e1f6464825f257e62f5ab667e798661b602714859b041fd2c43f4fb4b79c723ea0db7cd5d8ecd4b1215b97c4"
    PLATFORM_REGISTRY_INTEGRITY="sha512-fswvyGprAPCMiOEue/7MKMk7pCjh9kZIJfJX5i9atmfnmGYbYCcUhZsEH9LEP0+0t5xyPqDbfNXY7NSxIVuXxA=="
    ;;
  Linux:aarch64|Linux:arm64)
    CODEX_TARGET="linux-arm64"
    EXPECTED_PLATFORM_SHA512="aa2603c649041675c6ee3a1a7495ba43e5dc8320d70a919da5af6793f73e8b4804a26babd63edb1efc75d8d7d658217fcbc4eaae2e9acbe14bb82d8c8dd7a1b4"
    PLATFORM_REGISTRY_INTEGRITY="sha512-qiYDxkkEFnXG7joadJW6Q+XcgyDXCpGdpa9nk/c+i0gEomur1j7bHvx12NfWWCF/y8Tqri6ay+FLuC2MjdehtA=="
    ;;
  *)
    printf '[codex-install] unsupported Codex target: %s/%s\n' "$(uname -s)" "$(uname -m)" >&2
    exit 2
    ;;
esac

PLATFORM_VERSION="${CODEX_VERSION}-${CODEX_TARGET}"
PLATFORM_ALIAS="@openai/codex-${CODEX_TARGET}"
install_base="${BOT_WORKDIR:-${RUNNER_TEMP:-/tmp}}"
mkdir -p "$install_base"
install_base="$(cd "$install_base" && pwd -P)"
INSTALL_ROOT="${install_base}/codex-install"
PREFIX="${INSTALL_ROOT}/npm"
mkdir -p "$INSTALL_ROOT"
wrapper_tarball="${INSTALL_ROOT}/codex-${CODEX_VERSION}.tgz"
platform_tarball="${INSTALL_ROOT}/codex-${PLATFORM_VERSION}.tgz"
wrapper_url="https://registry.npmjs.org/@openai/codex/-/codex-${CODEX_VERSION}.tgz"
platform_url="https://registry.npmjs.org/@openai/codex/-/codex-${PLATFORM_VERSION}.tgz"
wrapper_metadata_url="https://registry.npmjs.org/@openai%2fcodex/${CODEX_VERSION}"
platform_metadata_url="https://registry.npmjs.org/@openai%2fcodex/${PLATFORM_VERSION}"
wrapper_attestation_url="https://registry.npmjs.org/-/npm/v1/attestations/@openai%2fcodex@${CODEX_VERSION}"
platform_attestation_url="https://registry.npmjs.org/-/npm/v1/attestations/@openai%2fcodex@${PLATFORM_VERSION}"

printf '[codex-install] package=%s version=%s source_tag=%s source_commit=%s\n' \
  "$CODEX_PACKAGE" "$CODEX_VERSION" "$CODEX_SOURCE_TAG" "$CODEX_SOURCE_COMMIT"
printf '[codex-install] target=%s platform_package=@openai/codex@%s\n' "$CODEX_TARGET" "$PLATFORM_VERSION"
printf '[codex-install] wrapper_registry_integrity=%s\n' "$WRAPPER_REGISTRY_INTEGRITY"
printf '[codex-install] platform_registry_integrity=%s\n' "$PLATFORM_REGISTRY_INTEGRITY"

wrapper_metadata="${INSTALL_ROOT}/codex-${CODEX_VERSION}.metadata.json"
platform_metadata="${INSTALL_ROOT}/codex-${PLATFORM_VERSION}.metadata.json"
wrapper_attestation="${INSTALL_ROOT}/codex-${CODEX_VERSION}.attestation.json"
platform_attestation="${INSTALL_ROOT}/codex-${PLATFORM_VERSION}.attestation.json"
curl --fail --silent --show-error --location "$wrapper_metadata_url" --output "$wrapper_metadata"
curl --fail --silent --show-error --location "$platform_metadata_url" --output "$platform_metadata"
curl --fail --silent --show-error --location "$wrapper_attestation_url" --output "$wrapper_attestation"
curl --fail --silent --show-error --location "$platform_attestation_url" --output "$platform_attestation"
workflow_identity="https://github.com/openai/codex/.github/workflows/rust-release.yml@refs/tags/${CODEX_SOURCE_TAG}"
sigstore_verifier="${INSTALL_ROOT}/verify-codex-sigstore.mjs"
if ! bun build "$script_dir/verify-codex-sigstore.ts" --target=node --outfile "$sigstore_verifier" >/dev/null \
  || ! node "$sigstore_verifier" \
    "$wrapper_attestation" "$platform_attestation" "$workflow_identity" "${INSTALL_ROOT}/sigstore-tuf"; then
  printf '[codex-install] Sigstore trust-root verification failed\n' >&2
  exit 2
fi
rm -f -- "$sigstore_verifier"
if ! node - "$wrapper_metadata" "$platform_metadata" "$wrapper_attestation" "$platform_attestation" "$WRAPPER_REGISTRY_INTEGRITY" "$PLATFORM_REGISTRY_INTEGRITY" "$CODEX_SOURCE_TAG" "$CODEX_SOURCE_COMMIT" "$EXPECTED_WRAPPER_SHA512" "$EXPECTED_PLATFORM_SHA512" "$CODEX_TARGET" <<'NODE'
const fs = require("node:fs")
const crypto = require("node:crypto")
const [wrapperMetadataPath, platformMetadataPath, wrapperAttestationPath, platformAttestationPath, wrapperIntegrity, platformIntegrity, sourceTag, sourceCommit, wrapperDigest, platformDigest, target] = process.argv.slice(2)
const metadata = [JSON.parse(fs.readFileSync(wrapperMetadataPath, "utf8")), JSON.parse(fs.readFileSync(platformMetadataPath, "utf8"))]
const expectedIntegrities = [wrapperIntegrity, platformIntegrity]
const expectedPackages = ["pkg:npm/%40openai/codex@0.146.0", `pkg:npm/%40openai/codex@0.146.0-${target}`]
const expectedDigests = [wrapperDigest, platformDigest]
const workflowRepository = "https://github.com/openai/codex"
const workflowPath = ".github/workflows/rust-release.yml"
const workflowRef = `refs/tags/${sourceTag}`
const workflowUri = `${workflowRepository}/${workflowPath}@${workflowRef}`
const workflowBuildType = "https://slsa-framework.github.io/github-actions-buildtypes/workflow/v1"
for (const [index, value] of metadata.entries()) {
  if (value.repository?.url !== "git+https://github.com/openai/codex.git" || value.repository?.directory !== "codex-cli") throw new Error("Codex registry repository provenance drift")
  if (value.dist?.integrity !== expectedIntegrities[index]) throw new Error("Codex registry integrity metadata drift")
  if (value.dist?.attestations?.provenance?.predicateType !== "https://slsa.dev/provenance/v1") throw new Error("Codex registry provenance attestation missing")
}
function pae(payloadType, payload) {
  const type = Buffer.from(payloadType)
  const body = Buffer.from(payload)
  return Buffer.concat([Buffer.from("DSSEv1 "), Buffer.from(String(type.length)), Buffer.from(" "), type, Buffer.from(" "), Buffer.from(String(body.length)), Buffer.from(" "), body])
}
for (const [index, path] of [wrapperAttestationPath, platformAttestationPath].entries()) {
  const value = JSON.parse(fs.readFileSync(path, "utf8"))
  const provenance = value.attestations?.find((entry) => entry.predicateType === "https://slsa.dev/provenance/v1")
  const bundle = provenance?.bundle
  const envelope = bundle?.dsseEnvelope
  const rawBytes = bundle?.verificationMaterial?.certificate?.rawBytes
  if (typeof rawBytes !== "string" || typeof envelope?.payload !== "string" || envelope.payloadType !== "application/vnd.in-toto+json") throw new Error("Codex SLSA DSSE bundle is incomplete")
  const signature = envelope.signatures?.find((entry) => typeof entry?.sig === "string")
  const tlog = Array.isArray(bundle.verificationMaterial?.tlogEntries)
    ? bundle.verificationMaterial.tlogEntries.find((entry) => entry?.kindVersion?.kind === "dsse")
    : undefined
  if (
    !signature || !tlog ||
    typeof tlog.logId?.keyId !== "string" || !tlog.logId.keyId ||
    typeof tlog.integratedTime !== "string" || !/^\d+$/.test(tlog.integratedTime) ||
    typeof tlog.canonicalizedBody !== "string" || !tlog.canonicalizedBody ||
    typeof tlog.inclusionPromise?.signedEntryTimestamp !== "string" || !tlog.inclusionPromise.signedEntryTimestamp ||
    typeof tlog.inclusionProof?.rootHash !== "string" || !tlog.inclusionProof.rootHash ||
    !Array.isArray(tlog.inclusionProof.hashes) || tlog.inclusionProof.hashes.length === 0 ||
    typeof tlog.inclusionProof.treeSize !== "string" || !/^\d+$/.test(tlog.inclusionProof.treeSize) ||
    typeof tlog.inclusionProof.checkpoint?.envelope !== "string" || !tlog.inclusionProof.checkpoint.envelope
  ) throw new Error("Codex SLSA DSSE signature or Rekor inclusion proof missing")
  const certificate = new crypto.X509Certificate(Buffer.from(rawBytes, "base64"))
  if (!/O\s*=\s*sigstore\.dev/.test(certificate.issuer)) throw new Error("Codex SLSA certificate issuer drift")
  if (certificate.subjectAltName !== `URI:${workflowUri}`) throw new Error("Codex SLSA certificate workflow identity drift")
  const integratedTime = Number(tlog.integratedTime) * 1000
  if (!Number.isSafeInteger(integratedTime) || integratedTime < Date.parse(certificate.validFrom) || integratedTime > Date.parse(certificate.validTo)) {
    throw new Error("Codex SLSA certificate validity does not cover Rekor integrated time")
  }
  const payloadBytes = Buffer.from(envelope.payload, "base64")
  if (!crypto.verify("sha256", pae(envelope.payloadType, payloadBytes), certificate.publicKey, Buffer.from(signature.sig, "base64"))) throw new Error("Codex SLSA DSSE signature invalid")
  const statement = JSON.parse(payloadBytes.toString("utf8"))
  if (statement._type !== "https://in-toto.io/Statement/v1" || statement.predicateType !== "https://slsa.dev/provenance/v1") throw new Error("Codex SLSA statement type drift")
  if (!Array.isArray(statement.subject) || statement.subject.length !== 1 || statement.subject[0]?.name !== expectedPackages[index] || statement.subject[0]?.digest?.sha512 !== expectedDigests[index]) throw new Error("Codex SLSA subject digest drift")
  const workflow = statement.predicate?.buildDefinition?.externalParameters?.workflow
  if (statement.predicate?.buildDefinition?.buildType !== workflowBuildType || workflow?.repository !== workflowRepository || workflow?.path !== workflowPath || workflow?.ref !== workflowRef) throw new Error("Codex source provenance workflow drift")
  const dependencies = statement.predicate?.buildDefinition?.resolvedDependencies
  const expectedSourceUri = `git+${workflowRepository}@${workflowRef}`
  if (!Array.isArray(dependencies) || !dependencies.some((dependency) => dependency?.uri === expectedSourceUri && dependency?.digest?.gitCommit === sourceCommit)) throw new Error("Codex source provenance commit drift")
}
NODE
then
  printf '[codex-install] source provenance validation failed\n' >&2
  exit 2
fi

printf '[codex-install] downloading %s\n' "$wrapper_url"
curl --fail --silent --show-error --location "$wrapper_url" --output "$wrapper_tarball"
actual_wrapper="$(sha256sum "$wrapper_tarball" | awk '{print $1}')"
[[ "$actual_wrapper" == "$EXPECTED_WRAPPER_SHA256" ]] || {
  printf '[codex-install] wrapper SHA256 mismatch expected=%s actual=%s\n' "$EXPECTED_WRAPPER_SHA256" "$actual_wrapper" >&2
  exit 2
}
actual_wrapper_sha512="$(sha512sum "$wrapper_tarball" | awk '{print $1}')"
[[ "$actual_wrapper_sha512" == "$EXPECTED_WRAPPER_SHA512" ]] || {
  printf '[codex-install] wrapper SHA512 mismatch expected=%s actual=%s\n' "$EXPECTED_WRAPPER_SHA512" "$actual_wrapper_sha512" >&2
  exit 2
}

printf '[codex-install] downloading %s\n' "$platform_url"
curl --fail --silent --show-error --location "$platform_url" --output "$platform_tarball"
actual_platform="$(sha512sum "$platform_tarball" | awk '{print $1}')"
[[ "$actual_platform" == "$EXPECTED_PLATFORM_SHA512" ]] || {
  printf '[codex-install] platform SHA512 mismatch expected=%s actual=%s\n' "$EXPECTED_PLATFORM_SHA512" "$actual_platform" >&2
  exit 2
}
printf '[codex-install] wrapper_sha256=%s wrapper_sha512=%s platform_sha512=%s\n' "$actual_wrapper" "$actual_wrapper_sha512" "$actual_platform"

stage="$(mktemp -d "${INSTALL_ROOT}/.npm-stage.XXXXXX")"
cleanup() {
  if [[ -n "${stage:-}" && -d "$stage" ]]; then rm -rf -- "$stage"; fi
}
trap cleanup EXIT
wrapper_dir="$stage/lib/node_modules/@openai/codex"
platform_dir="$stage/lib/node_modules/@openai/codex-${CODEX_TARGET}"
mkdir -p "$stage/bin" "$wrapper_dir" "$platform_dir"
tar -xzf "$wrapper_tarball" --strip-components=1 -C "$wrapper_dir"
tar -xzf "$platform_tarball" --strip-components=1 -C "$platform_dir"

node - "$wrapper_dir/package.json" "$platform_dir/package.json" "$PLATFORM_ALIAS" "$PLATFORM_VERSION" <<'NODE'
const fs = require("node:fs")
const [wrapperPath, platformPath, alias, platformVersion] = process.argv.slice(2)
const wrapper = JSON.parse(fs.readFileSync(wrapperPath, "utf8"))
const platform = JSON.parse(fs.readFileSync(platformPath, "utf8"))
if (wrapper.name !== "@openai/codex" || wrapper.version !== "0.146.0" || wrapper.bin?.codex !== "bin/codex.js") {
  throw new Error("Codex wrapper package metadata drift")
}
if (wrapper.optionalDependencies?.[alias] !== `npm:@openai/codex@${platformVersion}`) {
  throw new Error("Codex platform alias metadata drift")
}
if (platform.name !== "@openai/codex" || platform.version !== platformVersion) {
  throw new Error("Codex platform package metadata drift")
}
NODE

bwrap_bin="$(find "$platform_dir/vendor" -type f -path '*/codex-resources/bwrap' -print -quit)"
[[ -n "$bwrap_bin" && -x "$bwrap_bin" ]] || {
  printf '[codex-install] bundled bubblewrap is missing from the verified platform package\n' >&2
  exit 2
}
bwrap_target="$(realpath --relative-to="$stage/bin" "$bwrap_bin")"
ln -s "$bwrap_target" "$stage/bin/bwrap"

chmod 0755 "$wrapper_dir/bin/codex.js"
ln -s "../lib/node_modules/@openai/codex/bin/codex.js" "$stage/bin/codex"
rm -rf -- "$PREFIX"
mv "$stage" "$PREFIX"
stage=""

codex_bin="$PREFIX/bin/codex"
[[ -x "$codex_bin" ]] || { printf '[codex-install] installed Codex binary is missing: %s\n' "$codex_bin" >&2; exit 2; }
bwrap_bin="$PREFIX/bin/bwrap"
[[ -x "$bwrap_bin" ]] || { printf '[codex-install] installed bundled bubblewrap is missing: %s\n' "$bwrap_bin" >&2; exit 2; }
version_output="$("$codex_bin" --version)"
[[ "$version_output" == "codex-cli ${CODEX_VERSION}" ]] || {
  printf '[codex-install] version mismatch: %s\n' "$version_output" >&2
  exit 2
}
if [[ -n "${GITHUB_ENV:-}" ]]; then
  printf 'CODEX_BIN=%s\n' "$codex_bin" >>"$GITHUB_ENV"
fi
if [[ -n "${GITHUB_PATH:-}" ]]; then
  printf '%s\n' "$PREFIX/bin" >>"$GITHUB_PATH"
fi
printf '[codex-install] %s (%s) bundled_bwrap=%s\n' "$version_output" "$codex_bin" "$bwrap_bin"
