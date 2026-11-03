/**
 * Room Reservation Tools for Rock RMS
 */

import { RockClient } from '../rock-client.js';
import pkg from 'rrule';
const { rrulestr } = pkg;

export interface SearchReservationsParams {
  date?: string;
  startDate?: string;
  endDate?: string;
  name?: string;
  locationName?: string;
  reservationTypeId?: number;
  campusId?: number;
  approvalState?: number;
  limit?: number;
}

export const searchReservationsSchema = {
  name: 'search_reservations',
  description:
    'Search room reservations by date, name, location, type, or campus. ' +
    'Returns reservations with their locations, resources, schedule, ministry, and contact info. ' +
    'ApprovalState values: 0=Draft, 1=Unapproved, 2=Approved, 4=PendingSpecial, 5=PendingInitial. ' +
    'ReservationType IDs: 2=Baby/Wedding Shower, 3=Banquet, 4=Life Group/D-Group, 5=Conference, ' +
    '6=Funeral, 7=Ministry Event, 8=Staff Meeting, 9=Wedding, 10=Film Team, ' +
    '11=Weekday Preschool, 14=Outside Event, 15=Replicate.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      date: {
        type: 'string',
        description: 'Single date to query (YYYY-MM-DD). Finds all reservations active on this date.',
      },
      startDate: {
        type: 'string',
        description: 'Start of date range (YYYY-MM-DD). Use with endDate for multi-day queries.',
      },
      endDate: {
        type: 'string',
        description: 'End of date range (YYYY-MM-DD). Use with startDate for multi-day queries.',
      },
      name: {
        type: 'string',
        description: 'Search reservation name (partial match)',
      },
      locationName: {
        type: 'string',
        description: 'Filter by location/room name (e.g. "Garage", "Chapel", "WC1")',
      },
      reservationTypeId: {
        type: 'number',
        description: 'Filter by reservation type ID',
      },
      campusId: {
        type: 'number',
        description: 'Filter by campus ID',
      },
      approvalState: {
        type: 'number',
        description: 'Filter by approval state (2=Approved is most common)',
      },
      limit: {
        type: 'number',
        description: 'Maximum number of results (default: 50)',
      },
    },
  },
};

// --- Write tools ---

export interface CreateReservationParams {
  name: string;
  reservationTypeId: number;
  campusId?: number;
  ministryId?: number;
  numberOfAttending?: number;
  setupTime?: number;
  cleanupTime?: number;
  note?: string;
  eventContactEmail?: string;
  eventContactPhone?: string;
  startDateTime: string;
  endDateTime: string;
  locationIds?: number[];
}

export interface UpdateReservationParams {
  id: number;
  name?: string;
  numberOfAttending?: number;
  setupTime?: number;
  cleanupTime?: number;
  note?: string;
  approvalState?: number;
}

export const createReservationSchema = {
  name: 'create_reservation',
  description:
    'Create a new room reservation in Rock RMS. ' +
    'ReservationType IDs: 2=Baby/Wedding Shower, 3=Banquet, 4=Life Group/D-Group, 5=Conference, ' +
    '6=Funeral, 7=Ministry Event, 8=Staff Meeting, 9=Wedding, 10=Film Team, 14=Outside Event. ' +
    'Always confirm with the user before calling.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      name: { type: 'string', description: 'Reservation name' },
      reservationTypeId: { type: 'number', description: 'Reservation type ID' },
      campusId: { type: 'number', description: 'Campus ID' },
      ministryId: { type: 'number', description: 'ReservationMinistry ID' },
      numberOfAttending: { type: 'number', description: 'Expected number of attendees' },
      setupTime: { type: 'number', description: 'Setup time in minutes' },
      cleanupTime: { type: 'number', description: 'Cleanup time in minutes' },
      note: { type: 'string', description: 'Notes for the reservation' },
      eventContactEmail: { type: 'string', description: 'Event contact email' },
      eventContactPhone: { type: 'string', description: 'Event contact phone' },
      startDateTime: { type: 'string', description: 'Event start date/time (ISO 8601)' },
      endDateTime: { type: 'string', description: 'Event end date/time (ISO 8601)' },
      locationIds: { type: 'array', items: { type: 'number' }, description: 'Location/room IDs to reserve' },
    },
    required: ['name', 'reservationTypeId', 'startDateTime', 'endDateTime'],
  },
};

export const updateReservationSchema = {
  name: 'update_reservation',
  description:
    'Update an existing reservation in Rock RMS. Only provided fields are updated. ' +
    'ApprovalState: 0=Draft, 1=Unapproved, 2=Approved, 7=Cancelled. ' +
    'Always confirm with the user before calling.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      id: { type: 'number', description: 'The Reservation ID to update' },
      name: { type: 'string', description: 'Reservation name' },
      numberOfAttending: { type: 'number', description: 'Expected number of attendees' },
      setupTime: { type: 'number', description: 'Setup time in minutes' },
      cleanupTime: { type: 'number', description: 'Cleanup time in minutes' },
      note: { type: 'string', description: 'Notes' },
      approvalState: { type: 'number', description: '0=Draft, 1=Unapproved, 2=Approved, 7=Cancelled' },
    },
    required: ['id'],
  },
};

export async function createReservation(client: RockClient, params: CreateReservationParams): Promise<unknown> {
  // Create a schedule for the reservation
  const iCalContent = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'BEGIN:VEVENT',
    `DTSTART:${params.startDateTime.replace(/[-:]/g, '').replace('.000Z', '').split('T').join('T')}`,
    `DTEND:${params.endDateTime.replace(/[-:]/g, '').replace('.000Z', '').split('T').join('T')}`,
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n');

  const scheduleId = await client.v1Post<number>('/Schedules', {
    iCalendarContent: iCalContent,
    EffectiveStartDate: params.startDateTime,
    EffectiveEndDate: params.endDateTime,
  });

  // Create the reservation
  const reservationId = await client.v1Post<number>('/Reservations', {
    Name: params.name,
    ReservationTypeId: params.reservationTypeId,
    CampusId: params.campusId || null,
    ReservationMinistryId: params.ministryId || null,
    ScheduleId: scheduleId,
    NumberAttending: params.numberOfAttending || 0,
    SetupTime: params.setupTime || 0,
    CleanupTime: params.cleanupTime || 0,
    Note: params.note || '',
    ApprovalState: 1, // Start as Unapproved
    EventContactEmail: params.eventContactEmail || '',
    EventContactPhone: params.eventContactPhone || '',
    AdministrativeContactEmail: params.eventContactEmail || '',
    AdministrativeContactPhone: params.eventContactPhone || '',
  });

  // Add locations if provided
  if (params.locationIds && params.locationIds.length > 0) {
    for (const locationId of params.locationIds) {
      await client.v1Post('/ReservationLocations', {
        ReservationId: reservationId,
        LocationId: locationId,
        ApprovalState: 1,
      });
    }
  }

  return {
    success: true,
    message: `Created reservation "${params.name}" (ID: ${reservationId})`,
    reservationId,
    scheduleId,
    approvalState: 'Unapproved',
  };
}

export async function updateReservation(client: RockClient, params: UpdateReservationParams): Promise<unknown> {
  const body: Record<string, unknown> = {};

  if (params.name !== undefined) body.Name = params.name;
  if (params.numberOfAttending !== undefined) body.NumberAttending = params.numberOfAttending;
  if (params.setupTime !== undefined) body.SetupTime = params.setupTime;
  if (params.cleanupTime !== undefined) body.CleanupTime = params.cleanupTime;
  if (params.note !== undefined) body.Note = params.note;
  if (params.approvalState !== undefined) body.ApprovalState = params.approvalState;

  if (Object.keys(body).length === 0) {
    return { success: false, error: 'No fields provided to update' };
  }

  await client.v1Patch(`/Reservations/${params.id}`, body);

  return { success: true, message: `Reservation ${params.id} updated` };
}

interface ReservationLocation {
  ReservationId: number;
  LocationId: number;
  ApprovalState: number;
  Id: number;
}

interface Location {
  Id: number;
  Name: string;
}

interface Schedule {
  Id: number;
  Name: string;
  FriendlyScheduleText: string;
  iCalendarContent: string;
}

interface ReservationResource {
  ReservationId: number;
  ResourceId: number;
  Quantity: number;
  ApprovalState: number;
  Id: number;
}

interface Resource {
  Id: number;
  Name: string;
  Quantity?: number;
}

interface ReservationMinistry {
  Id: number;
  Name: string;
  ReservationTypeId: number;
}

interface ReservationType {
  Id: number;
  Name: string;
}

interface Reservation {
  Id: number;
  Name: string;
  ReservationTypeId: number;
  ScheduleId: number;
  CampusId: number;
  ReservationMinistryId: number | null;
  ApprovalState: number;
  SetupTime: number;
  CleanupTime: number;
  NumberAttending: number;
  Note: string;
  FirstOccurrenceStartDateTime: string;
  LastOccurrenceEndDateTime: string;
  EventContactEmail: string;
  EventContactPhone: string;
  AdministrativeContactEmail: string;
  AdministrativeContactPhone: string;
  CreatedDateTime: string;
  ModifiedDateTime: string;
}

const APPROVAL_STATE_NAMES: Record<number, string> = {
  0: 'Draft',
  1: 'Unapproved',
  2: 'Approved',
  3: 'Denied',
  4: 'PendingSpecial',
  5: 'PendingInitial',
  6: 'ChangesNeeded',
  7: 'Cancelled',
};

/** Parse iCal date string like "20260410T060000" to a Date */
function parseICalDate(icalDate: string): Date {
  const y = parseInt(icalDate.substring(0, 4));
  const m = parseInt(icalDate.substring(4, 6)) - 1;
  const d = parseInt(icalDate.substring(6, 8));
  const h = parseInt(icalDate.substring(9, 11));
  const min = parseInt(icalDate.substring(11, 13));
  const s = parseInt(icalDate.substring(13, 15));
  return new Date(y, m, d, h, min, s);
}

/**
 * Extract rrule-compatible lines from iCalendar content.
 * rrulestr can't parse full VCALENDAR blocks — it needs just DTSTART, RRULE, and EXDATE lines.
 * Also handles Rock's EXDATE duration format (e.g., "20240414/P1D") which rrule.js doesn't support.
 */
function extractRRuleLines(iCalContent: string): string {
  const lines = iCalContent.split(/\r?\n/);
  const relevant: string[] = [];
  for (const l of lines) {
    if (/^(DTSTART|RRULE)/.test(l)) {
      relevant.push(l);
    } else if (/^EXDATE/.test(l)) {
      // Handle Rock's duration format: EXDATE:20240414/P1D -> EXDATE:20240414T000000
      const match = l.match(/^EXDATE[^:]*:(\d{8})\//);
      if (match) {
        relevant.push('EXDATE:' + match[1] + 'T000000');
      } else if (!l.includes('/')) {
        relevant.push(l);
      }
    }
  }
  return relevant.join('\n');
}

/**
 * Parse iCalendar content and check if the schedule has an occurrence on the given date.
 * Returns the event start/end times for that occurrence, or null if no occurrence.
 */
function getOccurrenceOnDate(
  iCalContent: string,
  queryDate: string
): { start: Date; end: Date } | null {
  if (!iCalContent || !iCalContent.trim()) return null;

  try {
    const dtstartMatch = iCalContent.match(/DTSTART(?:;[^:]*)?:(\d{8}T\d{6})/);
    const dtendMatch = iCalContent.match(/DTEND(?:;[^:]*)?:(\d{8}T\d{6})/);

    if (!dtstartMatch) return null;

    const dtstart = parseICalDate(dtstartMatch[1]);
    const dtend = dtendMatch ? parseICalDate(dtendMatch[1]) : null;
    const duration = dtend ? dtend.getTime() - dtstart.getTime() : 0;

    const hasRRule = /RRULE:/.test(iCalContent);

    const [year, month, day] = queryDate.split('-').map(Number);
    const dayStart = new Date(year, month - 1, day, 0, 0, 0);
    const dayEnd = new Date(year, month - 1, day, 23, 59, 59);

    if (!hasRRule) {
      // Single occurrence or multi-day event — check if the query date overlaps
      const eventEnd = dtend || dtstart;
      if (dtstart <= dayEnd && eventEnd >= dayStart) {
        return { start: dtstart, end: eventEnd };
      }
      return null;
    }

    // Parse RRULE and check for occurrences on the query date
    const ruleStr = extractRRuleLines(iCalContent);
    const rule = rrulestr(ruleStr);

    const searchStart = new Date(Date.UTC(year, month - 1, day, 0, 0, 0));
    const searchEnd = new Date(Date.UTC(year, month - 1, day, 23, 59, 59));
    const occurrences = rule.between(searchStart, searchEnd, true);

    if (occurrences.length === 0) return null;

    // Map back to local time using the original DTSTART time components
    const localStart = new Date(
      year, month - 1, day,
      dtstart.getHours(), dtstart.getMinutes(), dtstart.getSeconds()
    );
    const localEnd = new Date(localStart.getTime() + duration);

    return { start: localStart, end: localEnd };
  } catch {
    // If parsing fails, include the reservation (fail open)
    return { start: new Date(queryDate), end: new Date(queryDate) };
  }
}

/**
 * Check if a schedule has any occurrence within a date range.
 */
function hasOccurrenceInRange(
  iCalContent: string,
  startDate: string,
  endDate: string
): boolean {
  if (!iCalContent || !iCalContent.trim()) return true; // fail open

  try {
    const dtstartMatch = iCalContent.match(/DTSTART(?:;[^:]*)?:(\d{8}T\d{6})/);
    const dtendMatch = iCalContent.match(/DTEND(?:;[^:]*)?:(\d{8}T\d{6})/);
    if (!dtstartMatch) return true;

    const dtstart = parseICalDate(dtstartMatch[1]);
    const dtend = dtendMatch ? parseICalDate(dtendMatch[1]) : dtstart;
    const hasRRule = /RRULE:/.test(iCalContent);

    const [sy, sm, sd] = startDate.split('-').map(Number);
    const [ey, em, ed] = endDate.split('-').map(Number);
    const rangeStart = new Date(sy, sm - 1, sd, 0, 0, 0);
    const rangeEnd = new Date(ey, em - 1, ed, 23, 59, 59);

    if (!hasRRule) {
      return dtstart <= rangeEnd && dtend >= rangeStart;
    }

    const ruleStr = extractRRuleLines(iCalContent);
    const rule = rrulestr(ruleStr);
    const searchStart = new Date(Date.UTC(sy, sm - 1, sd, 0, 0, 0));
    const searchEnd = new Date(Date.UTC(ey, em - 1, ed, 23, 59, 59));
    const occurrences = rule.between(searchStart, searchEnd, true);
    return occurrences.length > 0;
  } catch {
    return true; // fail open
  }
}

export async function searchReservations(
  client: RockClient,
  params: SearchReservationsParams
): Promise<unknown> {
  // Build OData filter for reservations
  const filters: string[] = [];

  // Date filtering: find reservations whose date range overlaps the query date(s)
  if (params.date) {
    filters.push(`FirstOccurrenceStartDateTime le datetime'${params.date}T23:59:59'`);
    filters.push(`LastOccurrenceEndDateTime ge datetime'${params.date}T00:00:00'`);
  } else if (params.startDate && params.endDate) {
    filters.push(`FirstOccurrenceStartDateTime le datetime'${params.endDate}T23:59:59'`);
    filters.push(`LastOccurrenceEndDateTime ge datetime'${params.startDate}T00:00:00'`);
  } else if (params.startDate) {
    filters.push(`LastOccurrenceEndDateTime ge datetime'${params.startDate}T00:00:00'`);
  } else if (params.endDate) {
    filters.push(`FirstOccurrenceStartDateTime le datetime'${params.endDate}T23:59:59'`);
  }

  if (params.name) {
    filters.push(`substringof('${params.name}', Name) eq true`);
  }

  if (params.reservationTypeId !== undefined) {
    filters.push(`ReservationTypeId eq ${params.reservationTypeId}`);
  }

  if (params.campusId !== undefined) {
    filters.push(`CampusId eq ${params.campusId}`);
  }

  if (params.approvalState !== undefined) {
    filters.push(`ApprovalState eq '${params.approvalState}'`);
  }

  const limit = params.limit || 50;

  // Fetch more than the user's limit since we'll filter by schedule occurrence.
  // The broad date range match returns many recurring events; most get filtered out.
  const fetchLimit = (params.date || (params.startDate && params.endDate)) ? 500 : limit;

  const queryParams: Record<string, string | number | undefined> = {
    $top: fetchLimit,
    $orderby: 'FirstOccurrenceStartDateTime',
  };

  if (filters.length > 0) {
    queryParams['$filter'] = filters.join(' and ');
  }

  const reservations = (await client.v1Get('/Reservations', queryParams)) as Reservation[];

  if (!reservations || reservations.length === 0) {
    return { reservations: [], count: 0 };
  }

  // Fetch schedules and filter by actual occurrence dates
  const uniqueScheduleIds = [...new Set(reservations.map((r) => r.ScheduleId).filter(Boolean))];
  const scheduleMap: Record<number, Schedule> = {};
  for (let i = 0; i < uniqueScheduleIds.length; i += 5) {
    const batch = uniqueScheduleIds.slice(i, i + 5);
    const filterStr = batch.map((id) => `Id eq ${id}`).join(' or ');
    const schedules = (await client.v1Get('/Schedules', {
      $filter: filterStr,
      $top: 500,
    })) as Schedule[];
    if (schedules) {
      for (const s of schedules) {
        scheduleMap[s.Id] = s;
      }
    }
  }

  // Filter reservations to only those that actually occur on the queried date(s)
  type ReservationWithOccurrence = Reservation & {
    _occurrenceStart?: Date;
    _occurrenceEnd?: Date;
    _scheduleDescription?: string;
  };

  let filteredReservations: ReservationWithOccurrence[];

  if (params.date) {
    filteredReservations = [];
    for (const r of reservations) {
      const schedule = scheduleMap[r.ScheduleId];
      if (!schedule || !schedule.iCalendarContent) {
        // No schedule data — include it (fail open)
        filteredReservations.push(r);
        continue;
      }
      const occurrence = getOccurrenceOnDate(schedule.iCalendarContent, params.date);
      if (occurrence) {
        const enriched: ReservationWithOccurrence = { ...r };
        enriched._occurrenceStart = occurrence.start;
        enriched._occurrenceEnd = occurrence.end;
        enriched._scheduleDescription = schedule.FriendlyScheduleText;
        filteredReservations.push(enriched);
      }
    }
  } else if (params.startDate && params.endDate) {
    filteredReservations = [];
    for (const r of reservations) {
      const schedule = scheduleMap[r.ScheduleId];
      if (!schedule || !schedule.iCalendarContent) {
        filteredReservations.push(r);
        continue;
      }
      if (hasOccurrenceInRange(schedule.iCalendarContent, params.startDate, params.endDate)) {
        const enriched: ReservationWithOccurrence = { ...r };
        enriched._scheduleDescription = schedule.FriendlyScheduleText;
        filteredReservations.push(enriched);
      }
    }
  } else {
    // No date filter — return all
    filteredReservations = reservations.map((r) => {
      const schedule = scheduleMap[r.ScheduleId];
      return { ...r, _scheduleDescription: schedule?.FriendlyScheduleText };
    });
  }

  if (filteredReservations.length === 0) {
    return { reservations: [], count: 0 };
  }

  // Now fetch related entities only for filtered reservations
  const reservationIds = filteredReservations.map((r) => r.Id);

  // Fetch reservation locations in batches
  const allResLocations: ReservationLocation[] = [];
  for (let i = 0; i < reservationIds.length; i += 5) {
    const batch = reservationIds.slice(i, i + 5);
    const filterStr = batch.map((id) => `ReservationId eq ${id}`).join(' or ');
    const locs = (await client.v1Get('/ReservationLocations', {
      $filter: filterStr,
      $top: 500,
    })) as ReservationLocation[];
    if (locs) allResLocations.push(...locs);
  }

  // Get unique location IDs and fetch names
  const uniqueLocationIds = [...new Set(allResLocations.map((l) => l.LocationId))];
  const locationNames: Record<number, string> = {};
  for (let i = 0; i < uniqueLocationIds.length; i += 5) {
    const batch = uniqueLocationIds.slice(i, i + 5);
    const filterStr = batch.map((id) => `Id eq ${id}`).join(' or ');
    const locations = (await client.v1Get('/Locations', {
      $filter: filterStr,
      $select: 'Id,Name',
      $top: 500,
    })) as Location[];
    if (locations) {
      for (const loc of locations) {
        locationNames[loc.Id] = loc.Name;
      }
    }
  }

  // Fetch reservation resources in batches
  const allResResources: ReservationResource[] = [];
  for (let i = 0; i < reservationIds.length; i += 5) {
    const batch = reservationIds.slice(i, i + 5);
    const filterStr = batch.map((id) => `ReservationId eq ${id}`).join(' or ');
    const resources = (await client.v1Get('/ReservationResources', {
      $filter: filterStr,
      $top: 500,
    })) as ReservationResource[];
    if (resources) allResResources.push(...resources);
  }

  // Get unique resource IDs and fetch names
  const uniqueResourceIds = [...new Set(allResResources.map((r) => r.ResourceId))];
  const resourceNames: Record<number, string> = {};
  if (uniqueResourceIds.length > 0) {
    for (let i = 0; i < uniqueResourceIds.length; i += 5) {
      const batch = uniqueResourceIds.slice(i, i + 5);
      const filterStr = batch.map((id) => `Id eq ${id}`).join(' or ');
      const resources = (await client.v1Get('/Resources', {
        $filter: filterStr,
        $select: 'Id,Name',
        $top: 500,
      })) as Resource[];
      if (resources) {
        for (const res of resources) {
          resourceNames[res.Id] = res.Name;
        }
      }
    }
  }

  // Fetch ministries and types for context
  const uniqueMinistryIds = [
    ...new Set(filteredReservations.map((r) => r.ReservationMinistryId).filter((id): id is number => id !== null)),
  ];
  const ministryNames: Record<number, string> = {};
  if (uniqueMinistryIds.length > 0) {
    for (let i = 0; i < uniqueMinistryIds.length; i += 5) {
      const batch = uniqueMinistryIds.slice(i, i + 5);
      const filterStr = batch.map((id) => `Id eq ${id}`).join(' or ');
      const ministries = (await client.v1Get('/ReservationMinistries', {
        $filter: filterStr,
        $select: 'Id,Name',
        $top: 500,
      })) as ReservationMinistry[];
      if (ministries) {
        for (const m of ministries) {
          ministryNames[m.Id] = m.Name;
        }
      }
    }
  }

  const uniqueTypeIds = [...new Set(filteredReservations.map((r) => r.ReservationTypeId))];
  const typeNames: Record<number, string> = {};
  for (let i = 0; i < uniqueTypeIds.length; i += 5) {
    const batch = uniqueTypeIds.slice(i, i + 5);
    const filterStr = batch.map((id) => `Id eq ${id}`).join(' or ');
    const types = (await client.v1Get('/ReservationTypes', {
      $filter: filterStr,
      $select: 'Id,Name',
      $top: 500,
    })) as ReservationType[];
    if (types) {
      for (const t of types) {
        typeNames[t.Id] = t.Name;
      }
    }
  }

  // Build enriched results
  const enriched = filteredReservations.map((r) => {
    const resLocs = allResLocations.filter((l) => l.ReservationId === r.Id);
    const locations = resLocs.map((l) => ({
      id: l.LocationId,
      name: locationNames[l.LocationId] || `Location ${l.LocationId}`,
      approvalState: APPROVAL_STATE_NAMES[l.ApprovalState] || String(l.ApprovalState),
    }));

    const resResources = allResResources.filter((rr) => rr.ReservationId === r.Id);
    const resources = resResources.map((rr) => ({
      id: rr.ResourceId,
      name: resourceNames[rr.ResourceId] || `Resource ${rr.ResourceId}`,
      quantity: rr.Quantity,
    }));

    return {
      id: r.Id,
      name: r.Name,
      type: typeNames[r.ReservationTypeId] || `Type ${r.ReservationTypeId}`,
      ministry: r.ReservationMinistryId ? ministryNames[r.ReservationMinistryId] || null : null,
      approvalState: APPROVAL_STATE_NAMES[r.ApprovalState] || String(r.ApprovalState),
      eventStart: r._occurrenceStart?.toISOString() || r.FirstOccurrenceStartDateTime,
      eventEnd: r._occurrenceEnd?.toISOString() || r.LastOccurrenceEndDateTime,
      seriesStart: r.FirstOccurrenceStartDateTime,
      seriesEnd: r.LastOccurrenceEndDateTime,
      scheduleDescription: r._scheduleDescription || null,
      setupMinutes: r.SetupTime,
      cleanupMinutes: r.CleanupTime,
      numberAttending: r.NumberAttending,
      locations,
      resources,
      note: r.Note || null,
      eventContact: {
        email: r.EventContactEmail || null,
        phone: r.EventContactPhone || null,
      },
      adminContact: {
        email: r.AdministrativeContactEmail || null,
        phone: r.AdministrativeContactPhone || null,
      },
    };
  });

  // If filtering by location name, filter the results
  let filtered = enriched;
  if (params.locationName) {
    const search = params.locationName.toLowerCase();
    filtered = enriched.filter((r) => r.locations.some((l) => l.name.toLowerCase().includes(search)));
  }

  // Apply the user's requested limit to the final results
  const limited = filtered.slice(0, limit);

  return {
    count: limited.length,
    totalMatched: filtered.length,
    reservations: limited,
  };
}
