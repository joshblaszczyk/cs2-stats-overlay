// electron-builder custom sign hook for Azure Trusted Signing / Key Vault.
//
// Triggered automatically by electron-builder when `win.sign` in package.json
// points at this file. Receives the path of the file to sign.
//
// Required env vars (set these in GitHub Actions Secrets, NEVER commit):
//
//   AZURE_TENANT_ID            — Azure AD tenant ID
//   AZURE_CLIENT_ID            — App registration client ID
//   AZURE_CLIENT_SECRET        — App registration client secret
//   AZURE_CODE_SIGNING_ENDPOINT — e.g. https://eus.codesigning.azure.net
//   AZURE_CODE_SIGNING_ACCOUNT — Trusted Signing account name
//   AZURE_CODE_SIGNING_PROFILE — Certificate profile name
//
// Alternative for Key Vault (if not using Trusted Signing):
//   AZURE_KEYVAULT_URI         — https://<vault>.vault.azure.net
//   AZURE_KEYVAULT_CERT_NAME   — Certificate name in the vault

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

exports.default = async function sign(config) {
  const filePath = config.path;
  if (!filePath) {
    console.log('[azure-sign] no path given, skipping');
    return;
  }

  const {
    AZURE_TENANT_ID,
    AZURE_CLIENT_ID,
    AZURE_CLIENT_SECRET,
    AZURE_CODE_SIGNING_ENDPOINT,
    AZURE_CODE_SIGNING_ACCOUNT,
    AZURE_CODE_SIGNING_PROFILE,
    AZURE_KEYVAULT_URI,
    AZURE_KEYVAULT_CERT_NAME,
  } = process.env;

  // Skip silently when no credentials are set (local dev, PR builds).
  if (!AZURE_TENANT_ID || !AZURE_CLIENT_ID || !AZURE_CLIENT_SECRET) {
    console.log('[azure-sign] Azure credentials not set — skipping signing for', filePath);
    return;
  }

  console.log('[azure-sign] signing', filePath);

  // Path A: Azure Artifact Signing (formerly Trusted Signing).
  if (AZURE_CODE_SIGNING_ENDPOINT && AZURE_CODE_SIGNING_ACCOUNT && AZURE_CODE_SIGNING_PROFILE) {
    const metadata = {
      Endpoint: AZURE_CODE_SIGNING_ENDPOINT,
      CodeSigningAccountName: AZURE_CODE_SIGNING_ACCOUNT,
      CertificateProfileName: AZURE_CODE_SIGNING_PROFILE,
      CorrelationId: `cs2-stats-overlay-${Date.now()}`,
    };
    const metadataPath = path.join(os.tmpdir(), `trusted-signing-metadata-${Date.now()}.json`);
    fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 2));

    // The Trusted Signing DLIB is shipped via the `Microsoft.Trusted.Signing.Client`
    // NuGet package. On GitHub Actions windows-latest runners, install it once per
    // workflow and set TRUSTED_SIGNING_DLIB_PATH to the extracted .dll path.
    const dlibPath = process.env.TRUSTED_SIGNING_DLIB_PATH;
    if (!dlibPath || !fs.existsSync(dlibPath)) {
      throw new Error('[azure-sign] TRUSTED_SIGNING_DLIB_PATH not set or file missing. Install the NuGet package Microsoft.Trusted.Signing.Client and point TRUSTED_SIGNING_DLIB_PATH at Azure.CodeSigning.Dlib.dll');
    }

    // signtool.exe is shipped with the Windows SDK but is NOT on PATH by
    // default on GitHub's windows-latest runners. The release workflow
    // resolves it with a Get-ChildItem search and exports SIGNTOOL as the
    // absolute path; fall back to the bare name so local dev still works
    // when signtool IS on PATH.
    const signtoolExe = process.env.SIGNTOOL || 'signtool';
    try {
      execFileSync(signtoolExe, [
        'sign',
        '/v',
        '/debug',
        '/fd', 'SHA256',
        '/tr', 'http://timestamp.acs.microsoft.com',
        '/td', 'SHA256',
        '/dlib', dlibPath,
        '/dmdf', metadataPath,
        filePath,
      ], { stdio: 'inherit' });
    } finally {
      try { fs.unlinkSync(metadataPath); } catch {}
    }
    return;
  }

  // Path B: Azure Key Vault.
  if (AZURE_KEYVAULT_URI && AZURE_KEYVAULT_CERT_NAME) {
    execFileSync('AzureSignTool', [
      'sign',
      '-kvu', AZURE_KEYVAULT_URI,
      '-kvi', AZURE_CLIENT_ID,
      '-kvt', AZURE_TENANT_ID,
      '-kvs', AZURE_CLIENT_SECRET,
      '-kvc', AZURE_KEYVAULT_CERT_NAME,
      '-tr', 'http://timestamp.digicert.com',
      '-td', 'sha256',
      '-fd', 'sha256',
      filePath,
    ], { stdio: 'inherit' });
    return;
  }

  console.log('[azure-sign] no Azure Artifact Signing OR Key Vault env vars — skipping');
};
