const parseResponse = resp => resp.json();

const getResponse = r => (r && r.response ? r.response : r);

function fetchGuard(requestUrl, options = {}) {
  return global.fetch(requestUrl, options)
    .then(parseResponse)
    .then(getResponse)
    .catch((err) => {
      console.error(err);
    });
}

export default (url, params) => fetchGuard(url, {
  method: 'POST',
  headers: {
    Accept: 'application/json',
    'Content-Type': 'application/json',
  },
  body: JSON.stringify(params),
});

function fetchGuardUnsafe(requestUrl, options = {}) {
  return global.fetch(requestUrl, options);
}

export function postFetchUnsafe(url, params) {
  return fetchGuardUnsafe(url, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(params),
  });
}
