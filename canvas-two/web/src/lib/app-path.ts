const configuredBase = import.meta.env.BASE_URL || "/";

export const APP_BASE_URL = configuredBase === "/" ? "" : `/${configuredBase.replace(/^\/+|\/+$/g, "")}`;
export const API_BASE_URL = `${APP_BASE_URL}/api`;

function externalUrl(value: string) {
    return /^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(value);
}

export function appUrl(path = "") {
    if (!path) return APP_BASE_URL || "/";
    if (externalUrl(path) || path.startsWith(`${APP_BASE_URL}/`)) return path;
    return `${APP_BASE_URL}/${path.replace(/^\/+/, "")}`;
}

export function apiUrl(path = "") {
    if (externalUrl(path)) return path;
    const normalized = path.replace(/^\/+/, "").replace(/^api\/?/, "");
    return normalized ? `${API_BASE_URL}/${normalized}` : API_BASE_URL;
}
