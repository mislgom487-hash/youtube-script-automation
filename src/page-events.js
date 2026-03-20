// Page show callbacks — tab return notification
const pageShowCallbacks = {};

export function registerPageShowCallback(path, cb) {
    pageShowCallbacks[path] = cb;
}

export function triggerPageShow(path) {
    if (pageShowCallbacks[path]) pageShowCallbacks[path]();
}
