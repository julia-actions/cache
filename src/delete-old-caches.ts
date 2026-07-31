export enum DeleteOldCachesMode {
    Disabled = 'false',
    Enabled = 'true',
    Required = 'required'
}

export function parseDeleteOldCachesMode(inputValue: string): DeleteOldCachesMode {
    switch (inputValue) {
        case DeleteOldCachesMode.Disabled:
        case DeleteOldCachesMode.Enabled:
        case DeleteOldCachesMode.Required:
            return inputValue;
        default:
            throw new Error(
                `Invalid value for input 'delete-old-caches': '${inputValue}'. Expected 'true', 'false', or 'required'.`
            );
    }
}
