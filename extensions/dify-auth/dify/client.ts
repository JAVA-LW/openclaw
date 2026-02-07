import { HEADER_AUTHORIZATION } from "../constants.js";
import { DifyLogger } from "../utils/logger.js";

export async function verifyDifyKey(apiKey: string, baseUrl: string) {
  const res = await fetch(`${baseUrl}/site`, {
    headers: { [HEADER_AUTHORIZATION]: `Bearer ${apiKey}` },
  });
  if (!res.ok) {
    throw new Error(`Status ${res.status}`);
  }
  return (await res.json()) as { title?: string };
}

export async function uploadToDify(
  imageUrl: string,
  apiKey: string,
  baseUrl: string,
  logger?: DifyLogger,
): Promise<string> {
  const blob = await (await fetch(imageUrl)).blob();
  const formData = new FormData();
  formData.append("file", blob, "image.png");
  formData.append("user", "openclaw-user");

  if (logger) {
    logger.log("Uploading Image to Dify", { imageUrl, baseUrl });
  }

  const res = await fetch(`${baseUrl}/files/upload`, {
    method: "POST",
    headers: { [HEADER_AUTHORIZATION]: `Bearer ${apiKey}` },
    body: formData,
  });

  if (logger) {
    logger.log("Upload Response Status", { status: res.status, statusText: res.statusText });
  }

  if (!res.ok) {
    throw new Error(`Upload failed: ${res.status} ${res.statusText}`);
  }

  const json = await res.json();
  if (logger) {
    logger.log("Upload Response Body", json);
  }
  return json.id;
}

export async function uploadBase64ToDify(params: {
  data: string;
  mediaType: string;
  apiKey: string;
  baseUrl: string;
  filename?: string;
  logger?: DifyLogger;
}): Promise<string> {
  const buffer = Buffer.from(params.data, "base64");
  const blob = new Blob([buffer], { type: params.mediaType });
  const formData = new FormData();
  formData.append("file", blob, params.filename || "file");
  formData.append("user", "openclaw-user");

  if (params.logger) {
    params.logger.log("Uploading Base64 Image to Dify", {
      mediaType: params.mediaType,
      filename: params.filename,
      baseUrl: params.baseUrl,
    });
  }

  const res = await fetch(`${params.baseUrl}/files/upload`, {
    method: "POST",
    headers: { [HEADER_AUTHORIZATION]: `Bearer ${params.apiKey}` },
    body: formData,
  });

  if (params.logger) {
    params.logger.log("Base64 Upload Response Status", {
      status: res.status,
      statusText: res.statusText,
    });
  }

  if (!res.ok) {
    throw new Error(`Upload failed: ${res.status} ${res.statusText}`);
  }

  const json = await res.json();
  if (params.logger) {
    params.logger.log("Base64 Upload Response Body", json);
  }
  return json.id;
}
