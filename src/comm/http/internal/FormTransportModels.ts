import type { FormSnapshot, FormLoadOptions, FormWriteOptions } from '../FormRecordModels';

export interface FormTransportSnapshot extends FormSnapshot {
    renderedInputs?: Record<string, string>;
    pageToken?: string;
}
export interface FormTransportLoadOptions extends FormLoadOptions {
    query?: Record<string, string>;
    captureRenderedInputs?: boolean;
    tokenSource?: 'session' | 'page';
    sensitive?: boolean;
}
export interface FormTransportSubmitOptions extends FormWriteOptions {
    postAllRenderedInputs?: boolean;
    actionValue?: string;
    extraFields?: Record<string, string>;
    tokenSource?: 'session' | 'page';
    redirect?: 'follow' | 'manual';
    landing?: 'echo' | 'guarded';
    sensitive?: boolean;
}
export interface FormTransportResult {
    sysId: string;
    action: string;
    messages: string[];
    errors?: string[];
}
