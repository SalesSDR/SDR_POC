import { z } from 'zod';
import fs from 'fs';
import path from 'path';
import config from '../../config/env';
import db from '../../config/database';

// Schema for lead discovery filtering parameters
export const SearchCriteriaSchema = z.object({
  titles: z.array(z.string()).default([]),
  geographies: z.array(z.string()).default([]),
});

export type SearchCriteria = z.infer<typeof SearchCriteriaSchema>;

// Strict validation of the contact payload returned by the Apollo API
const apolloContactSchema = z.object({
  id: z.string().min(1, 'Apollo ID (id) must be a non-empty string'),
  first_name: z.string().nullable().optional(),
  last_name: z.string().nullable().optional(),
  title: z.string().nullable().optional(),
  linkedin_url: z.string().nullable().optional(),
  country: z.string().nullable().optional(),
  organization: z.object({
    name: z.string().nullable().optional()
  }).nullable().optional()
});

export type ApolloContact = z.infer<typeof apolloContactSchema>;

/**
 * Discovery Phase lead ingestion. Retrieves leads matching targeting parameters
 * and caches them locally inside PostgreSQL.
 * Uses ON CONFLICT to avoid writing duplicate leads and conserve API limits.
 * 
 * @param criteria The filtering settings including target designations and locations.
 */
export async function fetchAndCacheLeads(criteria: SearchCriteria): Promise<{
  totalProcessed: number;
  newlyInserted: number;
  duplicatesSkipped: number;
}> {
  const titles = criteria.titles || [];
  const geographies = criteria.geographies || [];

  if (config.NODE_ENV === 'development') {
    console.log(`[apollo-service] Ingestion evaluation criteria active. Titles: ${JSON.stringify(titles)}, Geographies: ${JSON.stringify(geographies)}`);
  }

  let rawContacts: any[] = [];

  // Toggle between live Apollo.io query calls and local JSON fixtures
  if (!config.ALLOW_LIVE_APOLLO) {
    console.log('[apollo-service] Ingesting leads via local testing fixture...');
    try {
      const mockFilePath = path.resolve(process.cwd(), 'src/services/data/mockLeads.json');
      const fileData = fs.readFileSync(mockFilePath, 'utf8');
      const parsedData = JSON.parse(fileData);
      rawContacts = parsedData.contacts || [];
    } catch (err: any) {
      console.error('[apollo-service] Failed to read mock files:', err.message);
      throw new Error(`Failed to load mock data: ${err.message}`);
    }
  } else {
    console.log('[apollo-service]: API connection active. Ingesting live targets...');
    console.log('[apollo-service]: POST request dispatched to api.apollo.io/v1/mixed_people/search');
    try {
      const response = await fetch('https://api.apollo.io/v1/mixed_people/search', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-cache',
          'X-Api-Key': config.APOLLO_API_KEY,
        },
        body: JSON.stringify({
          api_key: config.APOLLO_API_KEY,
          person_titles: titles,
          countries: geographies,
          page: 1,
          per_page: config.APOLLO_SEARCH_LIMIT,
        }),
      });

      if (!response.ok) {
        if (response.status === 403 || response.status === 401) {
          console.warn(`⚠️ [apollo-service]: Apollo API key has restricted access (${response.status} ${response.statusText}). Falling back to mock targets for testing...`);
          const mockFilePath = path.resolve(process.cwd(), 'src/services/data/mockLeads.json');
          const fileData = fs.readFileSync(mockFilePath, 'utf8');
          const parsedData = JSON.parse(fileData);
          rawContacts = parsedData.contacts || [];
        } else {
          throw new Error(`Apollo API response failed with status ${response.status}: ${response.statusText}`);
        }
      } else {
        const responseBody = (await response.json()) as any;
        rawContacts = responseBody.contacts || responseBody.people || [];
      }
    } catch (err: any) {
      if (err.message.includes('mock targets')) {
        throw err;
      }
      console.warn(`⚠️ [apollo-service]: Apollo request failed: ${err.message}. Falling back to mock targets for testing...`);
      const mockFilePath = path.resolve(process.cwd(), 'src/services/data/mockLeads.json');
      const fileData = fs.readFileSync(mockFilePath, 'utf8');
      const parsedData = JSON.parse(fileData);
      rawContacts = parsedData.contacts || [];
    }
  }

  let newlyInserted = 0;
  let duplicatesSkipped = 0;
  let totalProcessed = 0;

  for (const rawItem of rawContacts) {
    totalProcessed++;
    
    // Safely sanitize and parse the lead structure
    const parsedContact = apolloContactSchema.safeParse(rawItem);
    if (!parsedContact.success) {
      console.warn('[apollo-service] Skipping contact due to parsing errors:', parsedContact.error.format());
      continue;
    }

    const contact = parsedContact.data;

    try {
      // Idempotent PostgreSQL insertion
      const result = await db.query(
        `INSERT INTO prospects (
          apollo_id, 
          first_name, 
          last_name, 
          linkedin_url, 
          designation, 
          geography, 
          company_name, 
          status
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'NEW')
        ON CONFLICT (apollo_id) DO NOTHING`,
        [
          contact.id,
          contact.first_name || null,
          contact.last_name || null,
          contact.linkedin_url || null,
          contact.title || null,
          contact.country || null,
          contact.organization?.name || null,
        ]
      );

      if (result.rowCount && result.rowCount > 0) {
        newlyInserted++;
      } else {
        duplicatesSkipped++;
      }
    } catch (err: any) {
      console.error(`[apollo-service] Database write failed for lead id: ${contact.id}. Error:`, err.message);
    }
  }

  console.log(`[Database]: Complete. Total Found: ${totalProcessed} | Newly Inserted: ${newlyInserted} | Duplicates Skipped: ${duplicatesSkipped}.`);

  return {
    totalProcessed,
    newlyInserted,
    duplicatesSkipped,
  };
}
