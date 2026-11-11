import { clientMetadataDocument } from "@/lib/connectors/discovery";

// Kaizen AI's OAuth Client ID Metadata Document: a service that supports them (client_id_metadata_document_supported)
// takes this URL as the client id and reads our name, logo and redirect URL from here, so nothing is registered and
// nobody sets up an app. Public by design: it holds no secret. The URL it lists as client_id must be this one.
export function GET(request: Request) {
  const origin = new URL(request.url).origin;
  return Response.json(clientMetadataDocument(origin), { headers: { "cache-control": "public, max-age=3600" } });
}
