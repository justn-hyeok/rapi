export function redactChat(text: string): string {
  let safe = text;
  for (const [key, value] of Object.entries(process.env)) {
    if (
      /TOKEN|SECRET|PASSWORD|API_KEY|DATABASE_URL|PRIVATE_KEY|CURSOR|CREDENTIAL/i.test(
        key,
      ) &&
      value &&
      value.length >= 4
    )
      safe = safe.split(value).join("[REDACTED]");
  }
  return safe
    .replace(
      /("[^"\n]*(?:token|secret|password|api[_-]?key|credential|authorization)[^"\n]*"\s*:\s*)"(?:\\.|[^"\\])*"/gi,
      '$1"[REDACTED]"',
    )
    .replace(
      /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/g,
      "[REDACTED]",
    )
    .replace(/(?:postgres(?:ql)?:\/\/)[^\s]+/gi, "[REDACTED]")
    .replace(
      /\b(?:sk-[\w-]{10,}|gh[pousr]_[\w]{10,}|github_pat_[\w]{10,})\b/g,
      "[REDACTED]",
    )
    .replace(
      /((?:authorization|cookie|token|secret|password|api[_-]?key|cmd_api_key|cursor[\w.-]*(?:credential|auth|token)[\w.-]*)\s*[:=]\s*)(?:Bearer\s+)?[^\s,;]+/gi,
      "$1[REDACTED]",
    );
}
