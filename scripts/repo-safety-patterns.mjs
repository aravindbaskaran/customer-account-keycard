const gap = "[ \\t]*(?:\\r?\\n[ \\t]*)?";
const value = "(?![A-Za-z0-9_-]*=)[A-Za-z0-9_-]{16}";

export const literalApiKeyPattern = new RegExp(`api(?:_|-)?key${gap}[:=]${gap}["']?${value}`, "i");