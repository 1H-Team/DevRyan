// Minimal hosted-Supabase stand-in for import tests: the GET subset the cloud
// reader uses (select with text-cast aliases, order, limit, keyset `or`,
// `in` filters, the schema RPC) plus private object downloads. It records
// every request so tests can assert that nothing but allowlisted GETs occurs.
import http from 'node:http';

const compare = (left, right) => {
  if (typeof left === 'number' || typeof right === 'number') return Number(left) - Number(right);
  if (/^\d+$/.test(String(left)) && /^\d+$/.test(String(right))) return Number(left) - Number(right);
  return String(left) < String(right) ? -1 : String(left) > String(right) ? 1 : 0;
};

const parseCondition = (text) => {
  const match = /^([a-z_0-9]+)\.(eq|gt)\.(.+)$/.exec(text);
  if (!match) throw new Error(`Unsupported filter ${text}`);
  return { column: match[1], op: match[2], value: match[3] };
};

// "(a.gt.1,and(a.eq.1,b.gt.2))" → [[cond], [cond, cond]]
const parseOr = (value) => {
  const inner = value.replace(/^\(/, '').replace(/\)$/, '');
  const groups = [];
  let depth = 0;
  let current = '';
  for (const char of inner) {
    if (char === '(') depth += 1;
    if (char === ')') depth -= 1;
    if (char === ',' && depth === 0) {
      groups.push(current);
      current = '';
    } else current += char;
  }
  if (current) groups.push(current);
  return groups.map((group) => (group.startsWith('and(')
    ? group.slice(4, -1).split(',').map(parseCondition)
    : [parseCondition(group)]));
};

const matches = (row, condition) => {
  const order = compare(row[condition.column], condition.value);
  return condition.op === 'eq' ? order === 0 : order > 0;
};

export async function startFakeCloud({ tables, objects, schemaMarker = '20260908182901' }) {
  const requests = [];
  const hooks = { beforeResponse: null, status: null };
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://fake.invalid');
    requests.push({ method: request.method, path: url.pathname, search: url.search });
    const send = (status, body, type = 'application/json') => {
      response.writeHead(status, { 'content-type': type });
      response.end(body);
    };
    if (request.method !== 'GET') return send(405, '{}');
    if (hooks.status) {
      const status = hooks.status(url);
      if (status) return send(status, '{}');
    }
    hooks.beforeResponse?.(url);
    if (url.pathname === '/rest/v1/rpc/devryan_bot_schema_version') return send(200, JSON.stringify(schemaMarker));
    const object = /^\/storage\/v1\/object\/devryan-bot-objects\/objects\/(.+)$/.exec(url.pathname);
    if (object) {
      const bytes = objects.get(object[1]);
      return bytes ? send(200, bytes, 'application/octet-stream') : send(404, '{}');
    }
    const table = /^\/rest\/v1\/([a-z_]+)$/.exec(url.pathname)?.[1];
    if (!table || !tables.has(table)) return send(404, JSON.stringify({ code: 'PGRST205' }));
    let rows = [...tables.get(table)];
    for (const [key, value] of url.searchParams) {
      if (['select', 'order', 'limit', 'or'].includes(key)) continue;
      const inList = /^in\.\((.*)\)$/.exec(value);
      if (inList) {
        const values = new Set(inList[1].split(','));
        rows = rows.filter((row) => values.has(String(row[key])));
      } else if (value.startsWith('eq.')) {
        rows = rows.filter((row) => String(row[key]) === value.slice(3));
      }
    }
    const or = url.searchParams.get('or');
    if (or) {
      const groups = parseOr(or);
      rows = rows.filter((row) => groups.some((group) => group.every((condition) => matches(row, condition))));
    }
    const order = (url.searchParams.get('order') || '').split(',').filter(Boolean).map((part) => part.replace(/\.asc$/, ''));
    rows.sort((left, right) => {
      for (const column of order) {
        const result = compare(left[column], right[column]);
        if (result !== 0) return result;
      }
      return 0;
    });
    const limit = Number(url.searchParams.get('limit') || rows.length);
    rows = rows.slice(0, limit);
    const select = (url.searchParams.get('select') || '*').split(',');
    const projected = rows.map((row) => {
      const output = {};
      for (const field of select) {
        const alias = /^([a-z0-9_]+):([a-z0-9_]+)::text$/.exec(field);
        if (alias) output[alias[1]] = row[alias[2]] === null || row[alias[2]] === undefined ? null : String(row[alias[2]]);
        else if (field === '*') Object.assign(output, row);
        else output[field] = row[field] ?? null;
      }
      return output;
    });
    return send(200, JSON.stringify(projected));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    tables,
    requests,
    hooks,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
