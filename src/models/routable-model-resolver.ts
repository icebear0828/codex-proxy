/**
 * 可路由 Codex 宿主模型解析器（共享）。
 *
 * Images API 需要把客户端传来的 `model: "gpt-image-2"` 转换成一个真正可路由
 * 的 Codex Responses 聊天宿主模型。这个模块提供一组共享函数，供：
 *   - Images 路由（`src/routes/images.ts`）在运行时做最终防线校验；
 *   - Dashboard 的 general-settings 端点（`src/routes/admin/settings.ts`）
 *     在保存前校验并规范化管理员输入的宿主模型；
 * 复用同一套解析规则，避免两处各自堆条件分支。
 *
 * 解析规则复用 `model-store.ts` 的 `isRecognizedModelName` / `parseModelName` /
 * `getModelInfo` / `buildDisplayModelName`：任意 catalog 模型 ID、custom_models
 * 中注册的 ID，或已注册的 alias 都能解析成 Canonical 值。未知模型**不**静默
 * 回落到 `model.default`，而是返回 `null` 让调用方感知失败。
 */

import {
  buildDisplayModelName,
  getModelAliases,
  getModelCatalog,
  getModelInfo,
  isRecognizedModelName,
  parseModelName,
} from "./model-store.js";

/** Images API 的客户端标识模型名——它不是可路由的 Codex 宿主模型。 */
export const IMAGE_HOST_MODEL_CLIENT_ID = "gpt-image-2";

/** 判断一个字符串（大小写不敏感）是否为 Images API 客户端标识 gpt-image-2。 */
export function isImageHostModelClientId(input: string): boolean {
  return input.trim().toLowerCase() === IMAGE_HOST_MODEL_CLIENT_ID;
}

/**
 * 把任意字符串（catalog 模型 ID、custom_models 中注册的 ID，或已注册的
 * alias）规范化为 Canonical 的可路由 Codex 聊天模型 ID。
 *
 * - 解析成功返回 Canonical ID；失败返回 `null`。
 * - 显式排除 `gpt-image-2`（大小写不敏感）——它是 Images API 客户端标识，
 *   不是可路由的宿主模型。
 * - 未知模型**不**静默回落到 `model.default`。
 */
export function resolveRoutableCodexHostModel(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed || isImageHostModelClientId(trimmed)) return null;
  if (!isRecognizedModelName(trimmed)) return null;
  const parsed = parseModelName(trimmed);
  if (!parsed.modelId || isImageHostModelClientId(parsed.modelId)) return null;
  if (!getModelInfo(parsed.modelId)) return null;
  return buildDisplayModelName(parsed);
}

/**
 * 可作为 image_host_model 的可选模型集合：当前 catalog 模型（static +
 * backend + custom_models）+ 可解析出 Canonical 值的 alias 名称。
 * 用于前端下拉展示，与 `resolveRoutableCodexHostModel` 的判定保持同源。
 */
export function getRoutableCodexHostModelAllowedModels(): string[] {
  const names = new Set<string>();

  // custom_models 已经由 ModelStore.applyConfiguredCustomModels 合并进 catalog，
  // 这里直接遍历 getModelCatalog() 即可覆盖 static + backend + custom 三类。
  for (const model of getModelCatalog()) {
    if (isImageHostModelClientId(model.id)) continue;
    names.add(model.id);
  }

  for (const alias of Object.keys(getModelAliases())) {
    if (resolveRoutableCodexHostModel(alias) !== null) names.add(alias);
  }

  return [...names].sort();
}
