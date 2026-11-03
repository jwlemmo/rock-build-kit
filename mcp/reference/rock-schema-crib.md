> Portability: observed behavior, not a version guarantee. Discover all IDs locally; examples are not production configuration.

# Rock RMS schema crib — core entities

Generated from the live OpenAPI v2 spec at `rock.example.org/api/v2/doc` (Rock **v17.6.1.0**). Refresh by re-downloading that spec and re-running `build_crib.py` — Rock ships point releases roughly monthly.

**Read this before writing ad-hoc SQL.** These are the API-layer property names (camelCase). Rock's raw SQL columns are the PascalCase form of the same names (`nickName` -> `NickName`, `givingId` -> `GivingId`), so this stops ~90% of column-name guessing. For the exact raw column list of any table, `INFORMATION_SCHEMA.COLUMNS` via `execute_sql` remains ground truth.

## Person  
<sub>`Rock.Model.Person` — 84 properties</sub>

```
accountProtectionProfile : integer(int32)
age : integer(int32)
ageBracket : integer(int32)
ageClassification : integer(int32)
anniversaryDate : string(date-time)
birthDate : string(date-time)
birthDateKey : integer(int32)
birthDay : integer(int32)
birthMonth : integer(int32)
birthYear : integer(int32)
birthdayDayOfWeek : string
birthdayDayOfWeekShort : string
communicationPreference : integer(int32)
connectionStatusValueId : integer(int32)
contributionFinancialAccountId : integer(int32)
createdByPersonAliasId : integer(int32)
createdDateTime : string(date-time)
daysToAnniversaryOrNull : integer(int32)
daysToBirthdayOrNull : integer(int32)
daysUntilAnniversary : integer(int32)
daysUntilBirthday : integer(int32)
deceasedDate : string(date-time)
email : string
emailNote : string
emailPreference : integer(int32)
ethnicityValueId : integer(int32)
firstName : string
firstNamePronunciationOverride : string
foreignGuid : string(uuid)
foreignId : integer(int32)
foreignKey : string
fullName : string
gender : integer(int32)
givingGroupId : integer(int32)
givingId : string
givingLeaderId : integer(int32)
gradeFormatted : string
gradeOffset : integer(int32)
graduationYear : integer(int32)
guid : string(uuid)
hasGraduated : boolean
id : integer(int32)
idKey : string
inactiveReasonNote : string
initials : string
isChatOpenDirectMessageAllowed : boolean
isChatProfilePublic : boolean
isDeceased : boolean
isEmailActive : boolean
isLockedAsChild : boolean
isSystem : boolean
lastName : string
lastNamePronunciationOverride : string
maritalStatusValueId : integer(int32)
middleName : string
modifiedAuditValuesAlreadyUpdated : boolean
modifiedByPersonAliasId : integer(int32)
modifiedDateTime : string(date-time)
nextAnniversary : string(date-time)
nextBirthDay : string(date-time)
nickName : string
nickNamePronunciationOverride : string
photoId : integer(int32)
preferredLanguageValueId : integer(int32)
primaryAliasGuid : string(uuid)
primaryAliasId : integer(int32)
primaryCampusId : integer(int32)
primaryFamilyId : integer(int32)
pronunciationNote : string
raceValueId : integer(int32)
recordStatusLastModifiedDateTime : string(date-time)
recordStatusReasonValueId : integer(int32)
recordStatusValueId : integer(int32)
recordTypeValueId : integer(int32)
reminderCount : integer(int32)
reviewReasonNote : string
reviewReasonValueId : integer(int32)
suffixValueId : integer(int32)
systemNote : string
titleValueId : integer(int32)
topSignalColor : string
topSignalIconCssClass : string
topSignalId : integer(int32)
viewedCount : integer(int32)
```

## PersonAlias  
<sub>`Rock.Model.PersonAlias` — 11 properties</sub>

```
aliasedDateTime : string(date-time)
foreignGuid : string(uuid)
foreignId : integer(int32)
foreignKey : string
guid : string(uuid)
id : integer(int32)
idKey : string
internalMessage : string
lastVisitDateTime : string(date-time)
name : string
personId : integer(int32)
```

## PhoneNumber  
<sub>`Rock.Model.PhoneNumber` — 25 properties</sub>

```
countryCode : string
createdByPersonAliasId : integer(int32)
createdDateTime : string(date-time)
description : string
extension : string
foreignGuid : string(uuid)
foreignId : integer(int32)
foreignKey : string
fullNumber : string
guid : string(uuid)
id : integer(int32)
idKey : string
isMessagingEnabled : boolean
isMessagingOptedOut : boolean
isSystem : boolean
isUnlisted : boolean
messagingOptedOutDateTime : string(date-time)
modifiedAuditValuesAlreadyUpdated : boolean
modifiedByPersonAliasId : integer(int32)
modifiedDateTime : string(date-time)
number : string
numberFormatted : string
numberFormattedWithCountryCode : string
numberTypeValueId : integer(int32)
personId : integer(int32)
```

## Group  
<sub>`Rock.Model.Group` — 61 properties</sub>

```
allowGuests : boolean
archivedByPersonAliasId : integer(int32)
archivedDateTime : string(date-time)
attendanceRecordRequiredForCheckIn : integer(int32)
campusId : integer(int32)
chatChannelKey : string
confirmationAdditionalDetails : string
createdByPersonAliasId : integer(int32)
createdDateTime : string(date-time)
description : string
disableScheduleToolboxAccess : boolean
disableScheduling : boolean
elevatedSecurityLevel : integer(int32)
foreignGuid : string(uuid)
foreignId : integer(int32)
foreignKey : string
groupAdministratorPersonAliasId : integer(int32)
groupCapacity : integer(int32)
groupSalutation : string
groupSalutationFull : string
groupTypeId : integer(int32)
guid : string(uuid)
id : integer(int32)
idKey : string
inactiveDateTime : string(date-time)
inactiveReasonNote : string
inactiveReasonValueId : integer(int32)
isActive : boolean
isArchived : boolean
isChatChannelAlwaysShownOverride : boolean
isChatChannelPublicOverride : boolean
isChatEnabledOverride : boolean
isLeavingChatChannelAllowedOverride : boolean
isPublic : boolean
isSecurityRole : boolean
isSpecialNeeds : boolean
isSystem : boolean
leaderToLeaderRelationshipMultiplierOverride : number(double)
leaderToNonLeaderRelationshipMultiplierOverride : number(double)
modifiedAuditValuesAlreadyUpdated : boolean
modifiedByPersonAliasId : integer(int32)
modifiedDateTime : string(date-time)
name : string
nonLeaderToLeaderRelationshipMultiplierOverride : number(double)
nonLeaderToNonLeaderRelationshipMultiplierOverride : number(double)
order : integer(int32)
parentGroupId : integer(int32)
relationshipGrowthEnabledOverride : boolean
relationshipStrengthOverride : integer(int32)
reminderAdditionalDetails : string
reminderOffsetDays : integer(int32)
reminderSystemCommunicationId : integer(int32)
requiredSignatureDocumentTemplateId : integer(int32)
rsvpReminderOffsetDays : integer(int32)
rsvpReminderSystemCommunicationId : integer(int32)
scheduleConfirmationLogic : integer(int32)
scheduleCoordinatorNotificationTypes : integer(int32)
scheduleCoordinatorPersonAliasId : integer(int32)
scheduleId : integer(int32)
schedulingMustMeetRequirements : boolean
statusValueId : integer(int32)
```

## GroupMember  
<sub>`Rock.Model.GroupMember` — 32 properties</sub>

```
archivedByPersonAliasId : integer(int32)
archivedDateTime : string(date-time)
communicationPreference : integer(int32)
createdByPersonAliasId : integer(int32)
createdDateTime : string(date-time)
dateTimeAdded : string(date-time)
foreignGuid : string(uuid)
foreignId : integer(int32)
foreignKey : string
groupId : integer(int32)
groupMemberStatus : integer(int32)
groupOrder : integer(int32)
groupRoleId : integer(int32)
groupTypeId : integer(int32)
guestCount : integer(int32)
guid : string(uuid)
id : integer(int32)
idKey : string
inactiveDateTime : string(date-time)
isArchived : boolean
isChatBanned : boolean
isChatMuted : boolean
isNotified : boolean
isSystem : boolean
modifiedAuditValuesAlreadyUpdated : boolean
modifiedByPersonAliasId : integer(int32)
modifiedDateTime : string(date-time)
note : string
personId : integer(int32)
scheduleReminderEmailOffsetDays : integer(int32)
scheduleStartDate : string(date-time)
scheduleTemplateId : integer(int32)
```

## GroupType  
<sub>`Rock.Model.GroupType` — 85 properties</sub>

```
administratorTerm : string
allowAnyChildGroupType : boolean
allowGroupSync : boolean
allowMultipleLocations : boolean
allowSpecificGroupMemberAttributes : boolean
allowSpecificGroupMemberWorkflows : boolean
allowedScheduleTypes : integer(int32)
alreadyEnrolledMatchingLogic : integer(int32)
attendanceCountsAsWeekendService : boolean
attendancePrintTo : integer(int32)
attendanceReminderFollowupDays : string
attendanceReminderSendStartOffsetMinutes : integer(int32)
attendanceReminderSystemCommunicationId : integer(int32)
attendanceRule : integer(int32)
createdByPersonAliasId : integer(int32)
createdDateTime : string(date-time)
defaultGroupRoleId : integer(int32)
description : string
enableGroupHistory : boolean
enableGroupTag : boolean
enableInactiveReason : boolean
enableLocationSchedules : boolean
enableRSVP : boolean
enableSpecificGroupRequirements : boolean
foreignGuid : string(uuid)
foreignId : integer(int32)
foreignKey : string
groupAttendanceRequiresLocation : boolean
groupAttendanceRequiresSchedule : boolean
groupCapacityRule : integer(int32)
groupMemberTerm : string
groupStatusDefinedTypeId : integer(int32)
groupTerm : string
groupTypeColor : string
groupTypePurposeValueId : integer(int32)
groupViewLavaTemplate : string
groupsRequireCampus : boolean
guid : string(uuid)
iconCssClass : string
id : integer(int32)
idKey : string
ignorePersonInactivated : boolean
inheritedGroupTypeId : integer(int32)
isCapacityRequired : boolean
isChatAllowed : boolean
isChatChannelAlwaysShown : boolean
isChatChannelPublic : boolean
isChatEnabledForAllGroups : boolean
isConcurrentCheckInPrevented : boolean
isIndexEnabled : boolean
isLeavingChatChannelAllowed : boolean
isPeerNetworkEnabled : boolean
isSchedulingEnabled : boolean
isSystem : boolean
leaderToLeaderRelationshipMultiplier : number(double)
leaderToNonLeaderRelationshipMultiplier : number(double)
locationSelectionMode : integer(int32)
locationTypes : array<Rock.Model.GroupTypeLocationType>
modifiedAuditValuesAlreadyUpdated : boolean
modifiedByPersonAliasId : integer(int32)
modifiedDateTime : string(date-time)
name : string
nonLeaderToLeaderRelationshipMultiplier : number(double)
nonLeaderToNonLeaderRelationshipMultiplier : number(double)
order : integer(int32)
relationshipGrowthEnabled : boolean
relationshipStrength : integer(int32)
requiresInactiveReason : boolean
requiresReasonIfDeclineSchedule : boolean
rsvpReminderOffsetDays : integer(int32)
rsvpReminderSystemCommunicationId : integer(int32)
scheduleCancellationWorkflowTypeId : integer(int32)
scheduleConfirmationEmailOffsetDays : integer(int32)
scheduleConfirmationLogic : integer(int32)
scheduleConfirmationSystemCommunicationId : integer(int32)
scheduleCoordinatorNotificationTypes : integer(int32)
scheduleReminderEmailOffsetDays : integer(int32)
scheduleReminderSystemCommunicationId : integer(int32)
sendAttendanceReminder : boolean
showAdministrator : boolean
showConnectionStatus : boolean
showInGroupList : boolean
showInNavigation : boolean
showMaritalStatus : boolean
takesAttendance : boolean
```

## GroupLocation  
<sub>`Rock.Model.GroupLocation` — 20 properties</sub>

```
createdByPersonAliasId : integer(int32)
createdDateTime : string(date-time)
foreignGuid : string(uuid)
foreignId : integer(int32)
foreignKey : string
groupId : integer(int32)
groupLocationScheduleConfigs : array<Rock.Model.GroupLocationScheduleConfig>
groupLocationTypeValueId : integer(int32)
groupMemberPersonAliasId : integer(int32)
guid : string(uuid)
id : integer(int32)
idKey : string
isMailingLocation : boolean
isMappedLocation : boolean
isOverflowLocation : boolean
locationId : integer(int32)
modifiedAuditValuesAlreadyUpdated : boolean
modifiedByPersonAliasId : integer(int32)
modifiedDateTime : string(date-time)
order : integer(int32)
```

## Attribute  
<sub>`Rock.Model.Attribute` — 45 properties</sub>

```
abbreviatedName : string
additionalSettingsJson : string
allowSearch : boolean
attributeColor : string
createdByPersonAliasId : integer(int32)
createdDateTime : string(date-time)
defaultPersistedCondensedHtmlValue : string
defaultPersistedCondensedTextValue : string
defaultPersistedHtmlValue : string
defaultPersistedTextValue : string
defaultValue : string
defaultValueChecksum : integer(int32)
description : string
enableHistory : boolean
entityTypeId : integer(int32)
entityTypeQualifierColumn : string
entityTypeQualifierValue : string
fieldTypeId : integer(int32)
foreignGuid : string(uuid)
foreignId : integer(int32)
foreignKey : string
guid : string(uuid)
iconCssClass : string
id : integer(int32)
idKey : string
isActive : boolean
isAnalytic : boolean
isAnalyticHistory : boolean
isDefaultPersistedValueDirty : boolean
isGridColumn : boolean
isIndexEnabled : boolean
isMultiValue : boolean
isPublic : boolean
isRequired : boolean
isSuppressHistoryLogging : boolean
isSystem : boolean
key : string
modifiedAuditValuesAlreadyUpdated : boolean
modifiedByPersonAliasId : integer(int32)
modifiedDateTime : string(date-time)
name : string
order : integer(int32)
postHtml : string
preHtml : string
showOnBulk : boolean
```

## AttributeValue  
<sub>Not a REST entity (attributes aren't navigable). SQL-only. Columns from INFORMATION_SCHEMA. — 23 columns (PascalCase = raw SQL)</sub>

```
Id : int
IsSystem : bit
AttributeId : int
EntityId : int
Value : nvarchar
Guid : uniqueidentifier
CreatedDateTime : datetime
ModifiedDateTime : datetime
CreatedByPersonAliasId : int
ModifiedByPersonAliasId : int
ForeignKey : nvarchar
ValueAsDateTime : datetime
ForeignGuid : uniqueidentifier
ForeignId : int
ValueAsNumeric : decimal
PersistedTextValue : nvarchar
PersistedHtmlValue : nvarchar
PersistedCondensedTextValue : nvarchar
PersistedCondensedHtmlValue : nvarchar
IsPersistedValueDirty : bit
ValueChecksum : int
ValueAsBoolean : bit
ValueAsPersonId : int
```

## Metric  
<sub>`Rock.Model.Metric` — 31 properties</sub>

```
adminPersonAliasId : integer(int32)
autoPartitionOnPrimaryCampus : boolean
createdByPersonAliasId : integer(int32)
createdDateTime : string(date-time)
dataViewId : integer(int32)
description : string
enableAnalytics : boolean
foreignGuid : string(uuid)
foreignId : integer(int32)
foreignKey : string
guid : string(uuid)
iconCssClass : string
id : integer(int32)
idKey : string
isCumulative : boolean
isSystem : boolean
lastRunDateTime : string(date-time)
measurementClassificationValueId : integer(int32)
metricChampionPersonAliasId : integer(int32)
modifiedAuditValuesAlreadyUpdated : boolean
modifiedByPersonAliasId : integer(int32)
modifiedDateTime : string(date-time)
scheduleId : integer(int32)
sourceLava : string
sourceSql : string
sourceValueTypeId : integer(int32)
subtitle : string
title : string
unitType : integer(int32)
xAxisLabel : string
yAxisLabel : string
```

## MetricValue  
<sub>`Rock.Model.MetricValue` — 22 properties</sub>

```
createdByPersonAliasId : integer(int32)
createdDateTime : string(date-time)
dateTimeStamp : integer(int64)
foreignGuid : string(uuid)
foreignId : integer(int32)
foreignKey : string
guid : string(uuid)
id : integer(int32)
idKey : string
metricId : integer(int32)
metricValueDateKey : integer(int32)
metricValueDateTime : string(date-time)
metricValuePartitionEntityIds : string
metricValueSourceDate : AnalyticsSourceDate
metricValueType : integer(int32)
modifiedAuditValuesAlreadyUpdated : boolean
modifiedByPersonAliasId : integer(int32)
modifiedDateTime : string(date-time)
note : string
seriesName : string
xValue : string
yValue : number(double)
```

## MetricPartition  
<sub>`Rock.Model.MetricPartition` — 18 properties</sub>

```
createdByPersonAliasId : integer(int32)
createdDateTime : string(date-time)
entityTypeId : integer(int32)
entityTypeQualifierColumn : string
entityTypeQualifierValue : string
foreignGuid : string(uuid)
foreignId : integer(int32)
foreignKey : string
guid : string(uuid)
id : integer(int32)
idKey : string
isRequired : boolean
label : string
metricId : integer(int32)
modifiedAuditValuesAlreadyUpdated : boolean
modifiedByPersonAliasId : integer(int32)
modifiedDateTime : string(date-time)
order : integer(int32)
```

## MetricValuePartition  
<sub>`Rock.Model.MetricValuePartition` — 14 properties</sub>

```
createdByPersonAliasId : integer(int32)
createdDateTime : string(date-time)
entityId : integer(int32)
foreignGuid : string(uuid)
foreignId : integer(int32)
foreignKey : string
guid : string(uuid)
id : integer(int32)
idKey : string
metricPartitionId : integer(int32)
metricValueId : integer(int32)
modifiedAuditValuesAlreadyUpdated : boolean
modifiedByPersonAliasId : integer(int32)
modifiedDateTime : string(date-time)
```

## MetricCategory  
<sub>`Rock.Model.MetricCategory` — 9 properties</sub>

```
categoryId : integer(int32)
foreignGuid : string(uuid)
foreignId : integer(int32)
foreignKey : string
guid : string(uuid)
id : integer(int32)
idKey : string
metricId : integer(int32)
order : integer(int32)
```

## Workflow  
<sub>`Rock.Model.Workflow` — 27 properties</sub>

```
activatedDateTime : string(date-time)
campusId : integer(int32)
completedDateTime : string(date-time)
createdByPersonAliasId : integer(int32)
createdDateTime : string(date-time)
description : string
entityId : integer(int32)
entityTypeId : integer(int32)
foreignGuid : string(uuid)
foreignId : integer(int32)
foreignKey : string
guid : string(uuid)
id : integer(int32)
idKey : string
initiatorPersonAliasId : integer(int32)
isActive : boolean
isPersisted : boolean
isProcessing : boolean
lastProcessedDateTime : string(date-time)
modifiedAuditValuesAlreadyUpdated : boolean
modifiedByPersonAliasId : integer(int32)
modifiedDateTime : string(date-time)
name : string
status : string
workflowId : string
workflowIdNumber : integer(int32)
workflowTypeId : integer(int32)
```

## WorkflowType  
<sub>`Rock.Model.WorkflowType` — 36 properties</sub>

```
categoryId : integer(int32)
completedWorkflowRetentionPeriod : integer(int32)
createdByPersonAliasId : integer(int32)
createdDateTime : string(date-time)
description : string
foreignGuid : string(uuid)
foreignId : integer(int32)
foreignKey : string
formBuilderSettingsJson : string
formBuilderTemplateId : integer(int32)
formEndDateTime : string(date-time)
formStartDateTime : string(date-time)
guid : string(uuid)
iconCssClass : string
id : integer(int32)
idKey : string
isActive : boolean
isFormBuilder : boolean
isLoginRequired : boolean
isPersisted : boolean
isSystem : boolean
logRetentionPeriod : integer(int32)
loggingLevel : integer(int32)
maxWorkflowAgeDays : integer(int32)
modifiedAuditValuesAlreadyUpdated : boolean
modifiedByPersonAliasId : integer(int32)
modifiedDateTime : string(date-time)
name : string
noActionMessage : string
order : integer(int32)
processingIntervalSeconds : integer(int32)
slug : string
summaryViewText : string
workTerm : string
workflowExpireDateTime : string(date-time)
workflowIdPrefix : string
```

## WorkflowActivity  
<sub>`Rock.Model.WorkflowActivity` — 20 properties</sub>

```
activatedByActivityId : integer(int32)
activatedDateTime : string(date-time)
activityTypeId : integer(int32)
assignedGroupId : integer(int32)
assignedPersonAliasId : integer(int32)
completedDateTime : string(date-time)
createdByPersonAliasId : integer(int32)
createdDateTime : string(date-time)
foreignGuid : string(uuid)
foreignId : integer(int32)
foreignKey : string
guid : string(uuid)
id : integer(int32)
idKey : string
isActive : boolean
lastProcessedDateTime : string(date-time)
modifiedAuditValuesAlreadyUpdated : boolean
modifiedByPersonAliasId : integer(int32)
modifiedDateTime : string(date-time)
workflowId : integer(int32)
```

## WorkflowActivityType  
<sub>`Rock.Model.WorkflowActivityType` — 17 properties</sub>

```
createdByPersonAliasId : integer(int32)
createdDateTime : string(date-time)
description : string
foreignGuid : string(uuid)
foreignId : integer(int32)
foreignKey : string
guid : string(uuid)
id : integer(int32)
idKey : string
isActivatedWithWorkflow : boolean
isActive : boolean
modifiedAuditValuesAlreadyUpdated : boolean
modifiedByPersonAliasId : integer(int32)
modifiedDateTime : string(date-time)
name : string
order : integer(int32)
workflowTypeId : integer(int32)
```

## WorkflowAction  
<sub>`Rock.Model.WorkflowAction` — 17 properties</sub>

```
actionTypeId : integer(int32)
activityId : integer(int32)
completedDateTime : string(date-time)
createdByPersonAliasId : integer(int32)
createdDateTime : string(date-time)
foreignGuid : string(uuid)
foreignId : integer(int32)
foreignKey : string
formAction : string
guid : string(uuid)
id : integer(int32)
idKey : string
isActive : boolean
lastProcessedDateTime : string(date-time)
modifiedAuditValuesAlreadyUpdated : boolean
modifiedByPersonAliasId : integer(int32)
modifiedDateTime : string(date-time)
```

## WorkflowActionType  
<sub>`Rock.Model.WorkflowActionType` — 22 properties</sub>

```
activityTypeId : integer(int32)
createdByPersonAliasId : integer(int32)
createdDateTime : string(date-time)
criteriaAttributeGuid : string(uuid)
criteriaComparisonType : integer(int32)
criteriaValue : string
entityTypeId : integer(int32)
foreignGuid : string(uuid)
foreignId : integer(int32)
foreignKey : string
guid : string(uuid)
id : integer(int32)
idKey : string
isActionCompletedIfCriteriaUnmet : boolean
isActionCompletedOnSuccess : boolean
isActivityCompletedOnSuccess : boolean
modifiedAuditValuesAlreadyUpdated : boolean
modifiedByPersonAliasId : integer(int32)
modifiedDateTime : string(date-time)
name : string
order : integer(int32)
workflowFormId : integer(int32)
```

## Page  
<sub>`Rock.Model.Page` — 46 properties</sub>

```
additionalSettingsJson : string
allowIndexing : boolean
bodyCssClass : string
botGuardianLevel : integer(int32)
breadCrumbDisplayIcon : boolean
breadCrumbDisplayName : boolean
browserTitle : string
cacheControlHeaderSettings : string
createdByPersonAliasId : integer(int32)
createdDateTime : string(date-time)
description : string
displayInNavWhen : integer(int32)
enableViewState : boolean
foreignGuid : string(uuid)
foreignId : integer(int32)
foreignKey : string
guid : string(uuid)
headerContent : string
iconBinaryFileId : integer(int32)
iconCssClass : string
id : integer(int32)
idKey : string
includeAdminFooter : boolean
internalName : string
isRateLimited : boolean
isSystem : boolean
keyWords : string
layoutId : integer(int32)
medianPageLoadTimeDurationSeconds : number(double)
menuDisplayChildPages : boolean
menuDisplayDescription : boolean
menuDisplayIcon : boolean
modifiedAuditValuesAlreadyUpdated : boolean
modifiedByPersonAliasId : integer(int32)
modifiedDateTime : string(date-time)
order : integer(int32)
pageDisplayBreadCrumb : boolean
pageDisplayDescription : boolean
pageDisplayIcon : boolean
pageDisplayTitle : boolean
pageTitle : string
parentPageId : integer(int32)
rateLimitPeriodDurationSeconds : integer(int32)
rateLimitRequestPerPeriod : integer(int32)
requiresEncryption : boolean
siteId : integer(int32)
```

## PageRoute  
<sub>`Rock.Model.PageRoute` — 15 properties</sub>

```
createdByPersonAliasId : integer(int32)
createdDateTime : string(date-time)
foreignGuid : string(uuid)
foreignId : integer(int32)
foreignKey : string
guid : string(uuid)
id : integer(int32)
idKey : string
isGlobal : boolean
isSystem : boolean
modifiedAuditValuesAlreadyUpdated : boolean
modifiedByPersonAliasId : integer(int32)
modifiedDateTime : string(date-time)
pageId : integer(int32)
route : string
```

## Block  
<sub>`Rock.Model.Block` — 25 properties</sub>

```
additionalSettings : string
blockLocation : integer(int32)
blockTypeId : integer(int32)
createdByPersonAliasId : integer(int32)
createdDateTime : string(date-time)
cssClass : string
foreignGuid : string(uuid)
foreignId : integer(int32)
foreignKey : string
guid : string(uuid)
id : integer(int32)
idKey : string
isSystem : boolean
layoutId : integer(int32)
modifiedAuditValuesAlreadyUpdated : boolean
modifiedByPersonAliasId : integer(int32)
modifiedDateTime : string(date-time)
name : string
order : integer(int32)
outputCacheDuration : integer(int32)
pageId : integer(int32)
postHtml : string
preHtml : string
siteId : integer(int32)
zone : string
```

## BlockType  
<sub>`Rock.Model.BlockType` — 16 properties</sub>

```
category : string
createdByPersonAliasId : integer(int32)
createdDateTime : string(date-time)
description : string
foreignGuid : string(uuid)
foreignId : integer(int32)
foreignKey : string
guid : string(uuid)
id : integer(int32)
idKey : string
isCommon : boolean
isSystem : boolean
modifiedAuditValuesAlreadyUpdated : boolean
modifiedByPersonAliasId : integer(int32)
modifiedDateTime : string(date-time)
name : string
```

## HtmlContent  
<sub>`Rock.Model.HtmlContent` — 20 properties</sub>

```
approvedByPersonAliasId : integer(int32)
approvedDateTime : string(date-time)
blockId : integer(int32)
content : string
createdByPersonAliasId : integer(int32)
createdDateTime : string(date-time)
entityValue : string
expireDateTime : string(date-time)
foreignGuid : string(uuid)
foreignId : integer(int32)
foreignKey : string
guid : string(uuid)
id : integer(int32)
idKey : string
isApproved : boolean
modifiedAuditValuesAlreadyUpdated : boolean
modifiedByPersonAliasId : integer(int32)
modifiedDateTime : string(date-time)
startDateTime : string(date-time)
version : integer(int32)
```

## Auth  
<sub>`Rock.Model.Auth` — 19 properties</sub>

```
action : string
allowOrDeny : string
createdByPersonAliasId : integer(int32)
createdDateTime : string(date-time)
entityId : integer(int32)
entityTypeId : integer(int32)
foreignGuid : string(uuid)
foreignId : integer(int32)
foreignKey : string
groupId : integer(int32)
guid : string(uuid)
id : integer(int32)
idKey : string
modifiedAuditValuesAlreadyUpdated : boolean
modifiedByPersonAliasId : integer(int32)
modifiedDateTime : string(date-time)
order : integer(int32)
personAliasId : integer(int32)
specialRole : integer(int32)
```

## Attendance  
<sub>`Rock.Model.Attendance` — 41 properties</sub>

```
attendanceCheckInSessionId : integer(int32)
attendanceCodeId : integer(int32)
campusId : integer(int32)
checkInStatus : integer(int32)
checkedInByPersonAliasId : integer(int32)
checkedOutByPersonAliasId : integer(int32)
createdByPersonAliasId : integer(int32)
createdDateTime : string(date-time)
declineReasonValueId : integer(int32)
deviceId : integer(int32)
didAttend : boolean
endDateTime : string(date-time)
foreignGuid : string(uuid)
foreignId : integer(int32)
foreignKey : string
guid : string(uuid)
id : integer(int32)
idKey : string
isFirstTime : boolean
modifiedAuditValuesAlreadyUpdated : boolean
modifiedByPersonAliasId : integer(int32)
modifiedDateTime : string(date-time)
note : string
occurrenceId : integer(int32)
personAliasId : integer(int32)
presentByPersonAliasId : integer(int32)
presentDateTime : string(date-time)
processed : boolean
qualifierValueId : integer(int32)
requestedToAttend : boolean
rsvp : integer(int32)
rsvpDateTime : string(date-time)
scheduleConfirmationSent : boolean
scheduleReminderSent : boolean
scheduledByPersonAliasId : integer(int32)
scheduledToAttend : boolean
searchResultGroupId : integer(int32)
searchTypeValueId : integer(int32)
searchValue : string
sourceValueId : integer(int32)
startDateTime : string(date-time)
```

## AttendanceOccurrence  
<sub>`Rock.Model.AttendanceOccurrence` — 30 properties</sub>

```
acceptConfirmationMessage : string
anonymousAttendanceCount : integer(int32)
attendanceReminderLastSentDateTime : string(date-time)
attendanceTypeValueId : integer(int32)
createdByPersonAliasId : integer(int32)
createdDateTime : string(date-time)
declineConfirmationMessage : string
declineReasonValueIds : string
didNotOccur : boolean
foreignGuid : string(uuid)
foreignId : integer(int32)
foreignKey : string
groupId : integer(int32)
guid : string(uuid)
id : integer(int32)
idKey : string
locationId : integer(int32)
modifiedAuditValuesAlreadyUpdated : boolean
modifiedByPersonAliasId : integer(int32)
modifiedDateTime : string(date-time)
name : string
notes : string
occurrenceDate : string(date-time)
occurrenceDateKey : integer(int32)
occurrenceSourceDate : AnalyticsSourceDate
rootGroupTypeId : integer(int32)
scheduleId : integer(int32)
showDeclineReasons : boolean
stepTypeId : integer(int32)
sundayDate : string(date-time)
```

## FinancialTransaction  
<sub>`Rock.Model.FinancialTransaction` — 40 properties</sub>

```
authorizedPersonAliasId : integer(int32)
batchId : integer(int32)
checkMicrEncrypted : string
checkMicrHash : string
checkMicrParts : string
createdByPersonAliasId : integer(int32)
createdDateTime : string(date-time)
financialGatewayId : integer(int32)
financialPaymentDetailId : integer(int32)
foreignCurrencyCodeValueId : integer(int32)
foreignGuid : string(uuid)
foreignId : integer(int32)
foreignKey : string
futureProcessingDateTime : string(date-time)
guid : string(uuid)
id : integer(int32)
idKey : string
isReconciled : boolean
isSettled : boolean
micrStatus : integer(int32)
modifiedAuditValuesAlreadyUpdated : boolean
modifiedByPersonAliasId : integer(int32)
modifiedDateTime : string(date-time)
nonCashAssetTypeValueId : integer(int32)
scheduledTransactionId : integer(int32)
settledDate : string(date-time)
settledDateKey : integer(int32)
settledGroupId : string
settledSourceDate : AnalyticsSourceDate
showAsAnonymous : boolean
sourceTypeValueId : integer(int32)
status : string
statusMessage : string
summary : string
sundayDate : string(date-time)
transactionCode : string
transactionDateKey : integer(int32)
transactionDateTime : string(date-time)
transactionSourceDate : AnalyticsSourceDate
transactionTypeValueId : integer(int32)
```

## FinancialTransactionDetail  
<sub>`Rock.Model.FinancialTransactionDetail` — 20 properties</sub>

```
accountId : integer(int32)
amount : number(double)
createdByPersonAliasId : integer(int32)
createdDateTime : string(date-time)
entityId : integer(int32)
entityTypeId : integer(int32)
feeAmount : number(double)
feeCoverageAmount : number(double)
foreignCurrencyAmount : number(double)
foreignGuid : string(uuid)
foreignId : integer(int32)
foreignKey : string
guid : string(uuid)
id : integer(int32)
idKey : string
modifiedAuditValuesAlreadyUpdated : boolean
modifiedByPersonAliasId : integer(int32)
modifiedDateTime : string(date-time)
summary : string
transactionId : integer(int32)
```

## FinancialAccount  
<sub>`Rock.Model.FinancialAccount` — 28 properties</sub>

```
accountTypeValueId : integer(int32)
campusId : integer(int32)
createdByPersonAliasId : integer(int32)
createdDateTime : string(date-time)
description : string
endDate : string(date-time)
foreignGuid : string(uuid)
foreignId : integer(int32)
foreignKey : string
glCode : string
guid : string(uuid)
id : integer(int32)
idKey : string
imageBinaryFileId : integer(int32)
isActive : boolean
isPublic : boolean
isTaxDeductible : boolean
modifiedAuditValuesAlreadyUpdated : boolean
modifiedByPersonAliasId : integer(int32)
modifiedDateTime : string(date-time)
name : string
order : integer(int32)
parentAccountId : integer(int32)
publicDescription : string
publicName : string
startDate : string(date-time)
url : string
usesCampusChildAccounts : boolean
```

## DefinedValue  
<sub>`Rock.Model.DefinedValue` — 19 properties</sub>

```
categoryId : integer(int32)
categoryName : string
createdByPersonAliasId : integer(int32)
createdDateTime : string(date-time)
definedTypeId : integer(int32)
description : string
foreignGuid : string(uuid)
foreignId : integer(int32)
foreignKey : string
guid : string(uuid)
id : integer(int32)
idKey : string
isActive : boolean
isSystem : boolean
modifiedAuditValuesAlreadyUpdated : boolean
modifiedByPersonAliasId : integer(int32)
modifiedDateTime : string(date-time)
order : integer(int32)
value : string
```

## DefinedType  
<sub>`Rock.Model.DefinedType` — 21 properties</sub>

```
categorizedValuesEnabled : boolean
categoryId : integer(int32)
createdByPersonAliasId : integer(int32)
createdDateTime : string(date-time)
description : string
enableSecurityOnValues : boolean
fieldTypeId : integer(int32)
foreignGuid : string(uuid)
foreignId : integer(int32)
foreignKey : string
guid : string(uuid)
helpText : string
id : integer(int32)
idKey : string
isActive : boolean
isSystem : boolean
modifiedAuditValuesAlreadyUpdated : boolean
modifiedByPersonAliasId : integer(int32)
modifiedDateTime : string(date-time)
name : string
order : integer(int32)
```

## Location  
<sub>`Rock.Model.Location` — 45 properties</sub>

```
assessorParcelId : string
barcode : string
beaconId : integer(int32)
city : string
country : string
county : string
createdByPersonAliasId : integer(int32)
createdDateTime : string(date-time)
distance : number(double)
firmRoomThreshold : integer(int32)
foreignGuid : string(uuid)
foreignId : integer(int32)
foreignKey : string
geoFence : System.Data.Entity.Spatial.DbGeography
geoFenceCoordinates : array<array>
geoPoint : System.Data.Entity.Spatial.DbGeography
geocodeAttemptedDateTime : string(date-time)
geocodeAttemptedResult : string
geocodeAttemptedServiceType : string
geocodedDateTime : string(date-time)
guid : string(uuid)
id : integer(int32)
idKey : string
imageId : integer(int32)
isActive : boolean
isGeoPointLocked : boolean
isNamedLocation : boolean
latitude : number(double)
locationTypeValueId : integer(int32)
longitude : number(double)
modifiedAuditValuesAlreadyUpdated : boolean
modifiedByPersonAliasId : integer(int32)
modifiedDateTime : string(date-time)
name : string
parentLocationId : integer(int32)
postalCode : string
printerDeviceId : integer(int32)
softRoomThreshold : integer(int32)
standardizeAttemptedDateTime : string(date-time)
standardizeAttemptedResult : string
standardizeAttemptedServiceType : string
standardizedDateTime : string(date-time)
state : string
street1 : string
street2 : string
```

## Schedule  
<sub>`Rock.Model.Schedule` — 27 properties</sub>

```
abbreviatedName : string
autoInactivateWhenComplete : boolean
categoryId : integer(int32)
checkInEndOffsetMinutes : integer(int32)
checkInStartOffsetMinutes : integer(int32)
createdByPersonAliasId : integer(int32)
createdDateTime : string(date-time)
description : string
effectiveEndDate : string(date-time)
effectiveStartDate : string(date-time)
foreignGuid : string(uuid)
foreignId : integer(int32)
foreignKey : string
friendlyScheduleText : string
guid : string(uuid)
iCalendarContent : string
id : integer(int32)
idKey : string
isActive : boolean
isPublic : boolean
modifiedAuditValuesAlreadyUpdated : boolean
modifiedByPersonAliasId : integer(int32)
modifiedDateTime : string(date-time)
name : string
order : integer(int32)
weeklyDayOfWeek : integer(int32)
weeklyTimeOfDay : string
```

## EntityType  
<sub>`Rock.Model.EntityType` — 20 properties</sub>

```
assemblyName : string
attributesSupportPrePostHtml : boolean
attributesSupportShowOnBulk : boolean
foreignGuid : string(uuid)
foreignId : integer(int32)
foreignKey : string
friendlyName : string
guid : string(uuid)
id : integer(int32)
idKey : string
isAchievementsEnabled : boolean
isCommon : boolean
isEntity : boolean
isIndexingEnabled : boolean
isMessageBusEventPublishEnabled : boolean
isRelatedToInteractionTrackedOnCreate : boolean
isSecured : boolean
multiValueFieldTypeId : integer(int32)
name : string
singleValueFieldTypeId : integer(int32)
```

## Tag  
<sub>`Rock.Model.Tag` — 23 properties</sub>

```
backgroundColor : string
categoryId : integer(int32)
createdByPersonAliasId : integer(int32)
createdDateTime : string(date-time)
description : string
entityTypeId : integer(int32)
entityTypeQualifierColumn : string
entityTypeQualifierValue : string
foreignGuid : string(uuid)
foreignId : integer(int32)
foreignKey : string
guid : string(uuid)
iconCssClass : string
id : integer(int32)
idKey : string
isActive : boolean
isSystem : boolean
modifiedAuditValuesAlreadyUpdated : boolean
modifiedByPersonAliasId : integer(int32)
modifiedDateTime : string(date-time)
name : string
order : integer(int32)
ownerPersonAliasId : integer(int32)
```

## TaggedItem  
<sub>`Rock.Model.TaggedItem` — 16 properties</sub>

```
createdByPersonAliasId : integer(int32)
createdDateTime : string(date-time)
entityGuid : string(uuid)
entityTypeId : integer(int32)
foreignGuid : string(uuid)
foreignId : integer(int32)
foreignKey : string
guid : string(uuid)
id : integer(int32)
idKey : string
isSystem : boolean
modifiedAuditValuesAlreadyUpdated : boolean
modifiedByPersonAliasId : integer(int32)
modifiedDateTime : string(date-time)
quantity : integer(int32)
tagId : integer(int32)
```

## Campus  
<sub>`Rock.Model.Campus` — 30 properties</sub>

```
beaconId : integer(int32)
campusStatusValueId : integer(int32)
campusTypeValueId : integer(int32)
closedDate : string(date-time)
createdByPersonAliasId : integer(int32)
createdDateTime : string(date-time)
description : string
foreignGuid : string(uuid)
foreignId : integer(int32)
foreignKey : string
guid : string(uuid)
id : integer(int32)
idKey : string
isActive : boolean
isSystem : boolean
leaderPersonAliasId : integer(int32)
locationId : integer(int32)
modifiedAuditValuesAlreadyUpdated : boolean
modifiedByPersonAliasId : integer(int32)
modifiedDateTime : string(date-time)
name : string
openedDate : string(date-time)
order : integer(int32)
phoneNumber : string
serviceTimes : string
shortCode : string
teamGroupId : integer(int32)
timeZoneId : string
titheMetric : number(double)
url : string
```

## Category  
<sub>`Rock.Model.Category` — 21 properties</sub>

```
createdByPersonAliasId : integer(int32)
createdDateTime : string(date-time)
description : string
entityTypeId : integer(int32)
entityTypeQualifierColumn : string
entityTypeQualifierValue : string
foreignGuid : string(uuid)
foreignId : integer(int32)
foreignKey : string
guid : string(uuid)
highlightColor : string
iconCssClass : string
id : integer(int32)
idKey : string
isSystem : boolean
modifiedAuditValuesAlreadyUpdated : boolean
modifiedByPersonAliasId : integer(int32)
modifiedDateTime : string(date-time)
name : string
order : integer(int32)
parentCategoryId : integer(int32)
```

## Report  
<sub>`Rock.Model.Report` — 22 properties</sub>

```
categoryId : integer(int32)
createdByPersonAliasId : integer(int32)
createdDateTime : string(date-time)
dataViewId : integer(int32)
description : string
entityTypeId : integer(int32)
fetchTop : integer(int32)
foreignGuid : string(uuid)
foreignId : integer(int32)
foreignKey : string
guid : string(uuid)
id : integer(int32)
idKey : string
isSystem : boolean
lastRunDateTime : string(date-time)
modifiedAuditValuesAlreadyUpdated : boolean
modifiedByPersonAliasId : integer(int32)
modifiedDateTime : string(date-time)
name : string
queryHint : string
runCount : integer(int32)
timeToRunDurationMilliseconds : integer(int32)
```

## DataView  
<sub>`Rock.Model.DataView` — 30 properties</sub>

```
categoryId : integer(int32)
createdByPersonAliasId : integer(int32)
createdDateTime : string(date-time)
dataViewFilterId : integer(int32)
description : string
disableUseOfReadOnlyContext : boolean
entityTypeId : integer(int32)
foreignGuid : string(uuid)
foreignId : integer(int32)
foreignKey : string
guid : string(uuid)
highlightColor : string
iconCssClass : string
id : integer(int32)
idKey : string
includeDeceased : boolean
isSystem : boolean
lastRunDateTime : string(date-time)
modifiedAuditValuesAlreadyUpdated : boolean
modifiedByPersonAliasId : integer(int32)
modifiedDateTime : string(date-time)
name : string
persistedLastRefreshDateTime : string(date-time)
persistedLastRunDurationMilliseconds : integer(int32)
persistedScheduleId : integer(int32)
persistedScheduleIntervalMinutes : integer(int32)
runCount : integer(int32)
runCountLastRefreshDateTime : string(date-time)
timeToRunDurationMilliseconds : number(double)
transformEntityTypeId : integer(int32)
```
