import { NextResponse } from "next/server";
import { getApiKeys, createApiKey } from "@/lib/localDb";
import { normalizeApiKeyProject } from "@/lib/db/repos/apiKeysRepo.js";
import { getConsistentMachineId } from "@/shared/utils/machineId";

export const dynamic = "force-dynamic";

// GET /api/keys - List API keys
export async function GET() {
  try {
    const keys = await getApiKeys();
    return NextResponse.json({ keys });
  } catch (error) {
    console.log("Error fetching keys:", error);
    return NextResponse.json({ error: "Failed to fetch keys" }, { status: 500 });
  }
}

// POST /api/keys - Create new API key
export async function POST(request) {
  try {
    const body = await request.json();
    const { name } = body;

    if (typeof name !== "string" || !name.trim()) {
      return NextResponse.json({ error: "Name is required" }, { status: 400 });
    }
    if (name.trim().length > 128) {
      return NextResponse.json({ error: "Name must be at most 128 characters" }, { status: 400 });
    }

    const project = normalizeApiKeyProject({
      projectId: body.projectId,
      projectLabel: body.projectLabel,
    });

    // Always get machineId from server. Project attribution is accepted only by
    // this dashboard-admin route, never from inference request headers.
    const machineId = await getConsistentMachineId();
    const apiKey = await createApiKey(name.trim(), machineId, project);

    return NextResponse.json({
      key: apiKey.key,
      name: apiKey.name,
      id: apiKey.id,
      machineId: apiKey.machineId,
      projectId: apiKey.projectId,
      projectLabel: apiKey.projectLabel,
    }, { status: 201 });
  } catch (error) {
    if (error instanceof TypeError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    console.log("Error creating key:", error);
    return NextResponse.json({ error: "Failed to create key" }, { status: 500 });
  }
}
