export const verifiedOn = "unverified: needs a store with classic customer accounts enabled. Never run against one; selectors are best-effort.";

export const sel = {
  email: "#CustomerEmail, input[name='customer[email]'], input[type='email']",
  password: "#CustomerPassword, input[name='customer[password]'], input[type='password']",
  submit: "form[action*='/account/login'] button[type='submit'], form[action*='/account/login'] input[type='submit']",
};
