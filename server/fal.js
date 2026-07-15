// Thin wrapper around fal.ai's NanoBanana image-editing model. Called only from
// the server so FAL_KEY never reaches the browser.

const FAL_ENDPOINT = "https://fal.run/fal-ai/nano-banana/edit";

// Take an input image (data URI) + a prompt, run NanoBanana, and return the
// generated image as a PNG data URI so the frontend and the checker can both
// use it uniformly.
export async function generate(inputDataUri, prompt) {
  if (!process.env.FAL_KEY) {
    throw new Error("FAL_KEY is not set. Add it to your .env file (see .env.example).");
  }
  if (!inputDataUri || !inputDataUri.startsWith("data:")) {
    throw new Error("An input image (data URI) is required.");
  }
  if (!prompt || !prompt.trim()) {
    throw new Error("A prompt is required.");
  }

  const res = await fetch(FAL_ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: `Key ${process.env.FAL_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      prompt,
      image_urls: [inputDataUri],
      num_images: 1,
      output_format: "png",
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`fal.ai request failed (${res.status}): ${body}`);
  }

  const data = await res.json();
  const url = data?.images?.[0]?.url;
  if (!url) {
    throw new Error("fal.ai returned no image.");
  }

  return await toDataUri(url);
}

// Fetch a (possibly remote or already-inline) image URL and return it as a
// base64 data URI.
async function toDataUri(url) {
  if (url.startsWith("data:")) return url;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Could not download generated image (${res.status}).`);
  }
  const contentType = res.headers.get("content-type") || "image/png";
  const buf = Buffer.from(await res.arrayBuffer());
  return `data:${contentType};base64,${buf.toString("base64")}`;
}
