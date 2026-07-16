const stable = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(stable);
  if (typeof value === "object" && value !== null)
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, stable(item)]),
    );
  return value;
};

export const createHash = async (value: unknown) => {
  const data = new TextEncoder().encode(JSON.stringify(stable(value)));
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
};
