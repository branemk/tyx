import { Class } from '../types/core';
import { EnumMetadata } from './enum';
import { IVarMetadata, ResultType, VarKind, VarMetadata } from './var';

export interface IResultMetadata extends IVarMetadata {
  design: Class;
  promise: boolean;
  defined: boolean;
  build: IVarMetadata;
}

export type ResultSelect<T = any> = {
  // tslint:disable-next-line:prefer-array-literal
  [P in keyof T]?: T[P] extends Array<infer U>
  ? (ResultSelect<U> | true | false | 1 | 2)
  : T[P] extends ReadonlyArray<infer U>
  ? (ResultSelect<U> | true | false | 1 | 2)
  : (ResultSelect<T[P]> | true | false | 1 | 2)
};

export class ResultMetadata implements IResultMetadata {
  public kind: VarKind = VarKind.Type;
  public design: Class = undefined;
  public promise: boolean = undefined;
  public item?: VarMetadata = undefined;
  public ref?: Class = undefined;
  public build: VarMetadata = undefined;
  public defined: boolean = false;

  public static of(def: ResultType): ResultMetadata;
  public static of(obj: IResultMetadata): ResultMetadata;
  public static of(defOrObj: IResultMetadata | ResultType): ResultMetadata {
    let obj = undefined;
    if (defOrObj === undefined) {
      obj = VarMetadata.of(undefined);
    } else if (defOrObj instanceof Function || defOrObj instanceof EnumMetadata || Array.isArray(defOrObj)) {
      obj = VarMetadata.of(defOrObj);
    } else if (defOrObj.kind) {
      obj = defOrObj;
    } else {
      throw new TypeError('Internal metadata error');
    }
    return obj && Object.setPrototypeOf(obj, ResultMetadata.prototype);
  }
}