// Passwords that must never be (re)used: the development seed's published passwords and the
// most common passwords that still pass the letter+digit rule.
const DENY = new Set([
  'admin@123', 'listener@123', 'curator@123', 'varsha@27',
  'password1', 'password123', 'passw0rd', 'qwerty123', 'abc12345', 'abcd1234', 'iloveyou1', 'welcome1',
  'admin123', 'letmein1', '1q2w3e4r', 'qwerty12', 'loop1234', 'music123', 'india123',
]);

function isWeakPassword(pw) {
  return DENY.has(String(pw || '').toLowerCase());
}

module.exports = { isWeakPassword, DENY };
