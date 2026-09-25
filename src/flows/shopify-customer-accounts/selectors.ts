export const sel = {
  accountButton: 'shopify-account button[aria-label="Account"], shopify-account button[part="signed-out-avatar"]',
  accountLink: 'a[href*="/account"]',
  loginForm: 'shopify-login-form form[aria-label="Sign in with email"], shopify-login-form form',
  loginEmail: "#login-form-email, input[type='email']",
  loginSubmit: "button[type='submit']",
  hostedEmail: "#customer-authentication-web-email, input[type='email']",
  hostedContinue: /continue/i,
  codePage: /\/authentication\/\d+\/code|\/account\/login\/code|\/code(\?|$)/,
  codeInput: "input[autocomplete='one-time-code'], input[inputmode='numeric'], input[aria-label*='code' i]",
  codeSubmit: /continue|submit|verify|sign in/i,
  accountPage: /shopify\.com\/\d+\/account(\?|$|\/)|\/account(\?|$|\/)/,
};
