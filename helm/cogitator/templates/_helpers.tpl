{{/*
Expand the name of the chart.
*/}}
{{- define "cogitator.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Create a default fully qualified app name.
We truncate at 63 chars because some Kubernetes name fields are limited to this (by the DNS naming spec).
If release name contains chart name it will be used as a full name.
*/}}
{{- define "cogitator.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- $name := default .Chart.Name .Values.nameOverride }}
{{- if contains $name .Release.Name }}
{{- .Release.Name | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}
{{- end }}

{{/*
Create chart name and version as used by the chart label.
*/}}
{{- define "cogitator.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Common labels
*/}}
{{- define "cogitator.labels" -}}
helm.sh/chart: {{ include "cogitator.chart" . }}
{{ include "cogitator.selectorLabels" . }}
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{/*
Selector labels
*/}}
{{- define "cogitator.selectorLabels" -}}
app.kubernetes.io/name: {{ include "cogitator.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{/*
Create the name of the service account to use
*/}}
{{- define "cogitator.serviceAccountName" -}}
{{- if .Values.serviceAccount.create }}
{{- default (include "cogitator.fullname" .) .Values.serviceAccount.name }}
{{- else }}
{{- default "default" .Values.serviceAccount.name }}
{{- end }}
{{- end }}

{{/*
Generate a random secret if not provided
*/}}
{{- define "cogitator.generateSecret" -}}
{{- randAlphaNum 32 | b64enc }}
{{- end }}

{{/*
Get Redis URL
*/}}
{{- define "cogitator.redisUrl" -}}
{{- if .Values.redis.external }}
{{- .Values.redis.url }}
{{- else if .Values.redis.enabled }}
{{- $redisHost := printf "%s-redis-master" .Release.Name }}
{{- $redisPort := "6379" }}
{{- if .Values.redis.auth.enabled }}
{{- printf "redis://:%s@%s:%s" .Values.redis.auth.password $redisHost $redisPort }}
{{- else }}
{{- printf "redis://%s:%s" $redisHost $redisPort }}
{{- end }}
{{- else }}
{{- "" }}
{{- end }}
{{- end }}

{{/*
Get PostgreSQL connection string
*/}}
{{- define "cogitator.databaseUrl" -}}
{{- if .Values.database.external }}
{{- .Values.database.connectionString }}
{{- else if .Values.postgresql.enabled }}
{{- $pgHost := printf "%s-postgresql" .Release.Name }}
{{- $pgPort := "5432" }}
{{- $pgUser := .Values.postgresql.auth.username }}
{{- $pgPass := .Values.postgresql.auth.password }}
{{- $pgDb := .Values.postgresql.auth.database }}
{{- printf "postgresql://%s:%s@%s:%s/%s" $pgUser $pgPass $pgHost $pgPort $pgDb }}
{{- else }}
{{- "" }}
{{- end }}
{{- end }}

{{/*
Get Ollama URL
*/}}
{{- define "cogitator.ollamaUrl" -}}
{{- if .Values.ollama.external }}
{{- .Values.ollama.url }}
{{- else if .Values.ollama.enabled }}
{{- "http://localhost:11434" }}
{{- else }}
{{- .Values.ollama.url | default "http://localhost:11434" }}
{{- end }}
{{- end }}
