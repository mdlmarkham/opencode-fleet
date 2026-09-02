/**
 * Shared SSH options for manager→node invocations.
 *
 * `StrictHostKeyChecking=accept-new` (TOFU) is the right default for a
 * Tailscale/private-network fleet: first contact accepts the host key
 * automatically, but *changed* keys are still refused. Prevents the
 * first-contact host-key failure (issue #2) without weakening MITM
 * detection for known hosts.
 */
export const SSH_ARGS = [
  "-o",
  "ConnectTimeout=10",
  "-o",
  "BatchMode=yes",
  "-o",
  "StrictHostKeyChecking=accept-new",
];
