// §13.2 / §16.5: one 5000-character row and one 10000-character row. 2.1.289 refused past 4096;
// 2.1.290 accepts any length. The status file is the reject signal; the rows themselves are the calls.
const FILE = '__LOG__/rd-uilog.json';

const row = (prefix, len) => prefix + 'x'.repeat(len - prefix.length);

const call = async ($, text) => {
  try {
    await Promise.resolve($.ui.log(text));
    return 'ok';
  } catch (error) {
    return `throw ${String(error?.message ?? error).slice(0, 180)}`;
  }
};

export const register = (on) => {
  on('session.start', { cwd: /./u }, async ($, e, next) => {
    const rows = [
      { len: 5000, text: row('RDLOG5 ', 5000) },
      { len: 10000, text: row('RDLOGA ', 10000) },
    ];
    const results = [];
    for (const item of rows) {
      const outcome = await call($, item.text);
      results.push({ len: item.len, outcome });
      await $.ui.log(`RDLOG status ${item.len} ${outcome}`);
    }
    await $.fs.write(FILE, `${JSON.stringify({ rows: results })}\n`).catch(() => undefined);
    return next(e);
  });
};
