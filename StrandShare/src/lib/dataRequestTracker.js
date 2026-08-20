let pendingRequestCount = 0;
let requestSequence = 0;
const listeners = new Set();

function getSnapshot() {
  return {
    pending: pendingRequestCount,
    sequence: requestSequence,
  };
}

function notifyListeners() {
  const snapshot = getSnapshot();
  listeners.forEach((listener) => listener(snapshot));
}

export function getDataRequestSnapshot() {
  return getSnapshot();
}

export function subscribeToDataRequests(listener) {
  listeners.add(listener);
  listener(getSnapshot());
  return () => listeners.delete(listener);
}

export function trackDataRequest(requestPromise) {
  pendingRequestCount += 1;
  requestSequence += 1;
  notifyListeners();

  return Promise.resolve(requestPromise).finally(() => {
    pendingRequestCount = Math.max(0, pendingRequestCount - 1);
    notifyListeners();
  });
}
