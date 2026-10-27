// Account-owned token: the user-level "create tokens" permission cannot be pre-filled in a link.
export const TOKEN_PERMISSIONS = [
  { key: "account_settings", type: "read" },
  { key: "workers_scripts", type: "edit" },
  { key: "account_api_tokens", type: "edit" },
  { key: "access", type: "edit" },
];

export function tokenLink(name: string): string {
  const params = new URLSearchParams({
    to: "/:account/api-tokens",
    permissionGroupKeys: JSON.stringify(TOKEN_PERMISSIONS),
    name,
  });
  return `https://dash.cloudflare.com/?${params}`;
}
