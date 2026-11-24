import { Router, type IRouter } from "express";
import { openai } from "@workspace/integrations-openai-ai-server";
import { TranscribeAudioBody, ExtractDataBody, ValidateRecordBody, UploadAudioBody } from "@workspace/api-zod";
import { requireAuth } from "../middleware/auth.js";
import { toFile } from "openai";
import { db, chemicalsTable, treatmentLogsTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { writeOperationalEvent } from "../lib/operations.js";

const router: IRouter = Router();

router.post("/transcribe", requireAuth, async (req, res) => {
  try {
    const body = TranscribeAudioBody.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: "Invalid request body" });
      return;
    }

    const audioBuffer = Buffer.from(body.data.audioBase64, "base64");
    const format = body.data.format;

    const file = await toFile(audioBuffer, `audio.${format}`, {
      type: `audio/${format}`,
    });

    const transcription = await openai.audio.transcriptions.create({
      model: "gpt-4o-mini-transcribe",
      file,
      language: "he",
      response_format: "json",
    });

    res.json({ text: transcription.text });
  } catch (err) {
    console.error("Transcription error:", err);
    res.status(500).json({ error: "Transcription failed" });
  }
});

router.post("/extract", requireAuth, async (req, res) => {
  try {
    const body = ExtractDataBody.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: "Invalid request body" });
      return;
    }

    const systemPrompt = `You are an agricultural field log data extractor for avocado orchards in Israel.
Extract structured data from Hebrew text describing agricultural treatments.
Return a JSON object with these fields:
- plotId: string or null (plot/block identifier mentioned)
- treatmentType: string or null (e.g., "ריסוס", "השקיה", "דישון", "קטיף")
- materialName: string or null (name of chemical/fertilizer/material used)
- dosage: string or null (dosage amount with units)
- waterVolume: string or null (water volume with units)
- workerName: string or null (name of worker or operator)
- operationDate: string or null (date in ISO format YYYY-MM-DD if mentioned)
- notes: string or null (any additional notes)
- confidenceScore: string (0-1 confidence in extraction quality)
- missingFields: array of strings listing fields that were not found

Be lenient with Hebrew transliterations and agricultural terminology.`;

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      max_completion_tokens: 2048,
      messages: [
        { role: "system", content: systemPrompt },
        {
          role: "user",
          content: `Extract agricultural treatment data from this text:\n\n${body.data.text}`,
        },
      ],
      response_format: { type: "json_object" },
    });

    const content = completion.choices[0]?.message?.content ?? "{}";
    const extracted = JSON.parse(content);

    const missingFields: string[] = [];
    const required = ["plotId", "treatmentType", "materialName", "dosage", "operationDate"];
    for (const field of required) {
      if (!extracted[field]) missingFields.push(field);
    }

    res.json({
      plotId: extracted.plotId ?? null,
      treatmentType: extracted.treatmentType ?? null,
      materialName: extracted.materialName ?? null,
      dosage: extracted.dosage ?? null,
      waterVolume: extracted.waterVolume ?? null,
      workerName: extracted.workerName ?? null,
      operationDate: extracted.operationDate ?? null,
      notes: extracted.notes ?? null,
      confidenceScore: extracted.confidenceScore ?? null,
      missingFields: extracted.missingFields ?? missingFields,
    });
  } catch (err) {
    console.error("Extraction error:", err);
    res.status(500).json({ error: "Extraction failed" });
  }
});

router.post("/validate", requireAuth, async (req, res) => {
  try {
    const body = ValidateRecordBody.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: "Invalid request body" });
      return;
    }

    const errors: string[] = [];
    const warnings: string[] = [];

    if (!body.data.treatmentType) {
      errors.push("סוג הטיפול חסר");
    }

    if (!body.data.plotId) {
      warnings.push("מגרש לא צוין");
    }

    let operationDateParsed: Date | null = null;
    if (!body.data.operationDate) {
      warnings.push("תאריך הפעולה חסר");
    } else {
      const date = new Date(body.data.operationDate);
      if (isNaN(date.getTime())) {
        errors.push("תאריך לא תקין");
      } else if (date > new Date()) {
        errors.push("תאריך לא יכול להיות בעתיד");
      } else {
        operationDateParsed = date;
      }
    }

    if (!body.data.workerName) {
      warnings.push("שם עובד חסר");
    }

    // Chemical dose range validation
    let dosageNum: number | null = null;
    if (body.data.dosage) {
      dosageNum = parseFloat(body.data.dosage);
      if (!isNaN(dosageNum) && dosageNum <= 0) {
        errors.push("מינון חייב להיות חיובי");
        dosageNum = null;
      }
    } else {
      warnings.push("מינון חסר");
    }

    if (body.data.chemicalId && dosageNum !== null) {
      const [chemical] = await db
        .select()
        .from(chemicalsTable)
        .where(eq(chemicalsTable.id, body.data.chemicalId))
        .limit(1);

      if (chemical) {
        const minDose = parseFloat(chemical.minDose);
        const maxDose = parseFloat(chemical.maxDose);
        if (dosageNum < minDose) {
          errors.push(`מינון נמוך מהמינימום המותר לחומר ${chemical.name} (מינימום: ${minDose})`);
        } else if (dosageNum > maxDose) {
          errors.push(`מינון גבוה מהמקסימום המותר לחומר ${chemical.name} (מקסימום: ${maxDose})`);
        }
      }
    }

    // Duplicate treatment detection: same plot + same chemical already treated
    if (body.data.plotId && body.data.chemicalId) {
      const existingRecords = await db
        .select({ id: treatmentLogsTable.id, operationDate: treatmentLogsTable.operationDate })
        .from(treatmentLogsTable)
        .where(
          and(
            eq(treatmentLogsTable.plotId, body.data.plotId),
            eq(treatmentLogsTable.chemicalId, body.data.chemicalId),
          )
        )
        .limit(5);

      if (existingRecords.length > 0) {
        // Check if any of the duplicates share the same operation date
        if (operationDateParsed) {
          const dateStr = operationDateParsed.toISOString().split("T")[0];
          const sameDayDuplicate = existingRecords.find(
            (r) => r.operationDate === dateStr
          );
          if (sameDayDuplicate) {
            warnings.push("נמצא טיפול כפול: אותו חומר ומגרש כבר טופל בתאריך זה");
          }
        } else {
          warnings.push("נמצא טיפול דומה: אותו חומר ומגרש כבר קיים ברשומות");
        }
      }
    }

    res.json({
      valid: errors.length === 0,
      errors,
      warnings,
    });
  } catch (err) {
    console.error("Validation error:", err);
    res.status(500).json({ error: "Validation failed" });
  }
});

router.post("/upload-audio", requireAuth, async (req, res) => {
  const startedAt = Date.now();
  try {
    const body = UploadAudioBody.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: "Invalid request body" });
      return;
    }

    const audioBuffer = Buffer.from(body.data.audioBase64, "base64");
    const format = body.data.format;

    const file = await toFile(audioBuffer, `audio.${format}`, {
      type: `audio/${format}`,
    });

    const transcription = await openai.audio.transcriptions.create({
      model: "gpt-4o-mini-transcribe",
      file,
      language: "he",
      response_format: "json",
    });

    const transcriptionText = transcription.text;

    const systemPrompt = `You are an agricultural field log data extractor for avocado orchards in Israel.
Extract structured data from Hebrew text describing agricultural treatments.
Return a JSON object with these fields:
- plotId: string or null
- treatmentType: string or null
- materialName: string or null
- dosage: string or null
- waterVolume: string or null
- workerName: string or null
- operationDate: string or null (ISO format)
- notes: string or null
- confidenceScore: string (0-1)
- missingFields: array of strings`;

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      max_completion_tokens: 2048,
      messages: [
        { role: "system", content: systemPrompt },
        {
          role: "user",
          content: `Extract agricultural treatment data from this Hebrew transcription:\n\n${transcriptionText}`,
        },
      ],
      response_format: { type: "json_object" },
    });

    const content = completion.choices[0]?.message?.content ?? "{}";
    const extracted = JSON.parse(content);

    const missingFields: string[] = [];
    const required = ["plotId", "treatmentType", "materialName", "dosage", "operationDate"];
    for (const field of required) {
      if (!extracted[field]) missingFields.push(field);
    }

    const response = {
      transcription: transcriptionText,
      extractedData: {
        plotId: extracted.plotId ?? null,
        treatmentType: extracted.treatmentType ?? null,
        materialName: extracted.materialName ?? null,
        dosage: extracted.dosage ?? null,
        waterVolume: extracted.waterVolume ?? null,
        workerName: extracted.workerName ?? null,
        operationDate: extracted.operationDate ?? null,
        notes: extracted.notes ?? null,
        confidenceScore: extracted.confidenceScore ?? null,
        missingFields: extracted.missingFields ?? missingFields,
      },
    };
    await writeOperationalEvent({
      userId: req.auth!.userId,
      eventType: "voice_processing",
      stage: "voice",
      status: response.extractedData.missingFields.length ? "warning" : "success",
      durationMs: Date.now() - startedAt,
      fallbackUsed: false,
      errorCode: null,
      metadata: {
        hasMissingFields: response.extractedData.missingFields.length > 0,
        missingFieldCount: response.extractedData.missingFields.length,
      },
    });
    res.json(response);
  } catch (err) {
    req.log.error({ err }, "Upload audio failed");
    await writeOperationalEvent({
      userId: req.auth!.userId,
      eventType: "voice_processing",
      stage: "voice",
      status: "error",
      durationMs: Date.now() - startedAt,
      fallbackUsed: false,
      errorCode: "AUDIO_PROCESSING_FAILED",
      metadata: null,
    });
    res.status(500).json({ error: "Audio processing failed" });
  }
});

export default router;
