// Prevent private dotenv secret-file settings from entering offline test processes.
const names = ['AUTH_TOKEN', 'KOTAK_ACCESS_TOKEN', 'KOTAK_MPIN', 'KOTAK_TOTP_SECRET', 'ZERODHA_API_KEY', 'ZERODHA_API_SECRET', 'ZERODHA_ACCESS_TOKEN', 'ZERODHA_REQUEST_TOKEN', 'AI_GATEWAY_API_KEY', 'TYPESAFE_AI_API_KEY', 'TELEGRAM_BOT_TOKEN'];
for (const name of names) {
  process.env[name] = '';
  process.env[`${name}_FILE`] = '';
}
Object.assign(process.env, { HOST: '127.0.0.1', APP_ORIGIN: '', TRUST_PROXY_IPS: '127.0.0.1,::1,::ffff:127.0.0.1' });
export {};
