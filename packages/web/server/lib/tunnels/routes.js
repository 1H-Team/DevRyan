import { ManagedRemoteTunnelTokenValidationError } from './managed-token.js';

export const createTunnelRoutesRuntime = (dependencies) => {
  const {
    crypto,
    URL,
    tunnelService,
    tunnelProviderRegistry,
    tunnelAuthController,
    readSettingsFromDiskMigrated,
    readManagedRemoteTunnelConfigFromDisk,
    normalizeTunnelProvider,
    normalizeTunnelMode,
    normalizeOptionalPath,
    normalizeManagedRemoteTunnelHostname,
    normalizeManagedRemoteOriginPort,
    isValidManagedRemoteOriginPort,
    normalizeTunnelBootstrapTtlMs,
    normalizeTunnelSessionTtlMs,
    isSupportedTunnelMode,
    upsertManagedRemoteTunnelToken,
    resolveManagedRemoteTunnelToken,
    resolveManagedRemoteTunnelPreset,
    TUNNEL_MODE_QUICK,
    TUNNEL_MODE_MANAGED_LOCAL,
    TUNNEL_MODE_MANAGED_REMOTE,
    TUNNEL_PROVIDER_CLOUDFLARE,
    TunnelServiceError,
    getActivePort,
    getRuntimeManagedRemoteTunnelHostname,
    setRuntimeManagedRemoteTunnelHostname,
    getRuntimeManagedRemoteTunnelToken,
    setRuntimeManagedRemoteTunnelToken,
    getActiveTunnelController,
    getRuntimeReady = () => true,
  } = dependencies;

  const resolveActiveNormalizedTunnelMode = () => {
    const mode = tunnelService.resolveActiveMode();
    if (mode === TUNNEL_MODE_MANAGED_LOCAL) {
      return TUNNEL_MODE_MANAGED_LOCAL;
    }
    if (mode === TUNNEL_MODE_MANAGED_REMOTE) {
      return TUNNEL_MODE_MANAGED_REMOTE;
    }
    return TUNNEL_MODE_QUICK;
  };

  const resolveNormalizedTunnelHost = (publicUrl) => {
    if (typeof publicUrl !== 'string' || publicUrl.trim().length === 0) {
      return null;
    }
    try {
      return new URL(publicUrl).hostname.toLowerCase();
    } catch {
      return null;
    }
  };

  const resolvePreferredTunnelProvider = async (reqBody = null) => {
    if (typeof reqBody?.provider === 'string' && reqBody.provider.trim().length > 0) {
      return normalizeTunnelProvider(reqBody.provider);
    }
    const activeProvider = tunnelService.resolveActiveProvider();
    if (activeProvider) {
      return normalizeTunnelProvider(activeProvider);
    }
    const settings = await readSettingsFromDiskMigrated();
    return normalizeTunnelProvider(settings?.tunnelProvider);
  };

  const startTunnelWithNormalizedRequest = async ({
    provider,
    mode,
    intent,
    hostname,
    token,
    configPath,
    selectedPresetId,
    selectedPresetName,
    originPort,
  }) => {
    if (!getRuntimeReady()) {
      throw new TunnelServiceError(
        'runtime_not_ready',
        'DevRyan is still starting. Wait for OpenCode to become ready before starting a tunnel.'
      );
    }

    if (provider === TUNNEL_PROVIDER_CLOUDFLARE && mode === TUNNEL_MODE_MANAGED_REMOTE) {
      if (!isValidManagedRemoteOriginPort(originPort)) {
        throw new TunnelServiceError(
          'validation_error',
          'Managed remote origin port must be an integer between 1024 and 65535'
        );
      }
      setRuntimeManagedRemoteTunnelHostname(hostname);
      setRuntimeManagedRemoteTunnelToken(token);

      if (token && hostname) {
        await upsertManagedRemoteTunnelToken({
          id: selectedPresetId || hostname,
          name: selectedPresetName || hostname,
          hostname,
          originPort,
          token,
        });
      }
    }

    const result = await tunnelService.start({
      provider,
      mode,
      intent,
      configPath,
      token,
      hostname,
      originPort,
    });

    console.log(`Tunnel active (${result.provider}): ${result.publicUrl}`);
    return {
      publicUrl: result.publicUrl,
      mode: result.activeMode,
      provider: result.provider,
      controllerReused: result.controllerReused,
      providerMetadata: result.providerMetadata,
    };
  };

  const createGenericModeChecks = ({ modeKey, requiredFields, doctorRequest, startupReady }) => {
    const checks = [
      {
        id: 'startup_readiness',
        label: 'Provider startup readiness',
        status: startupReady ? 'pass' : 'fail',
        detail: startupReady
          ? 'Provider dependency checks passed.'
          : 'Resolve provider checks before starting tunnels.',
      },
    ];

    for (const field of requiredFields) {
      const value = doctorRequest?.[field];
      const present = typeof value === 'string' ? value.trim().length > 0 : Boolean(value);
      checks.push({
        id: `requirement_${field}`,
        label: `Required: ${field}`,
        status: present ? 'pass' : 'fail',
        detail: present
          ? `${field} is configured.`
          : `${field} is required for ${modeKey}.`,
      });
    }

    const failures = checks.filter((entry) => entry.status === 'fail').length;
    const warnings = checks.filter((entry) => entry.status === 'warn').length;
    return {
      mode: modeKey,
      checks,
      summary: {
        ready: failures === 0,
        failures,
        warnings,
      },
      ready: failures === 0,
      blockers: checks
        .filter((entry) => entry.status === 'fail' && entry.id !== 'startup_readiness')
        .map((entry) => entry.detail || entry.label || entry.id),
    };
  };

  const runTunnelDoctor = async ({ providerId, modeFilter, doctorRequest }) => {
    const provider = tunnelProviderRegistry.get(providerId);
    if (!provider) {
      throw new TunnelServiceError('provider_unsupported', `Unsupported tunnel provider: ${providerId}`);
    }

    const capabilities = provider.capabilities || {};
    const modeKeys = Array.isArray(capabilities.modes)
      ? capabilities.modes.map((entry) => entry?.key).filter((key) => typeof key === 'string' && key.length > 0)
      : [];

    if (modeFilter && !modeKeys.includes(modeFilter)) {
      throw new TunnelServiceError('mode_unsupported', `Provider '${providerId}' does not support mode '${modeFilter}'`);
    }

    if (typeof provider.diagnose === 'function') {
      const diagnosed = await provider.diagnose({
        ...doctorRequest,
        mode: modeFilter || doctorRequest?.mode,
      }, {
        capabilities,
      });
      const providerChecks = Array.isArray(diagnosed?.providerChecks) ? diagnosed.providerChecks : [];
      const allModes = Array.isArray(diagnosed?.modes) ? diagnosed.modes : [];
      const modes = modeFilter ? allModes.filter((entry) => entry?.mode === modeFilter) : allModes;
      return {
        ok: true,
        provider: providerId,
        providerChecks,
        modes,
      };
    }

    const availability = await tunnelService.checkAvailability(providerId);
    const dependencyAvailable = Boolean(availability?.available);
    const providerChecks = [{
      id: 'dependency',
      label: 'Provider dependency',
      status: dependencyAvailable ? 'pass' : 'fail',
      detail: dependencyAvailable
        ? (availability?.version || 'available')
        : (availability?.message || 'Required provider dependency is unavailable.'),
    }];

    const targetModes = (Array.isArray(capabilities.modes) ? capabilities.modes : [])
      .filter((entry) => !modeFilter || entry?.key === modeFilter);
    const modes = targetModes.map((entry) => createGenericModeChecks({
      modeKey: entry.key,
      requiredFields: Array.isArray(entry?.requires) ? entry.requires : [],
      doctorRequest,
      startupReady: dependencyAvailable,
    }));

    return {
      ok: true,
      provider: providerId,
      providerChecks,
      modes,
    };
  };

  const registerRoutes = (app) => {
    app.get('/api/openchamber/tunnel/check', async (req, res) => {
      try {
        const requestedProvider = typeof req?.query?.provider === 'string' && req.query.provider.trim().length > 0
          ? normalizeTunnelProvider(req.query.provider)
          : await resolvePreferredTunnelProvider();
        const result = await tunnelService.checkAvailability(requestedProvider);
        res.json({
          available: result.available,
          provider: requestedProvider,
          version: result.version || null,
        });
      } catch (error) {
        console.warn('Tunnel dependency check failed:', error);
        res.json({ available: false, provider: null, version: null });
      }
    });

    const handleTunnelDoctor = async (req, res) => {
      try {
        const params = req.query || {};
        const body = req.body || {};

        const providerId = typeof params.provider === 'string' && params.provider.trim().length > 0
          ? normalizeTunnelProvider(params.provider)
          : await resolvePreferredTunnelProvider();
        const modeFilter = typeof params.mode === 'string' && params.mode.trim().length > 0
          ? params.mode.trim().toLowerCase()
          : null;

        const settings = await readSettingsFromDiskMigrated();
        const selectedPresetId = typeof params.managedRemoteTunnelPresetId === 'string'
          ? params.managedRemoteTunnelPresetId.trim()
          : '';
        const requestConfigPath = normalizeOptionalPath(params.configPath)
          ?? normalizeOptionalPath(settings?.managedLocalTunnelConfigPath);
        const requestManagedRemoteHostname = normalizeManagedRemoteTunnelHostname(params.managedRemoteTunnelHostname);
        const requestTunnelHostname = normalizeManagedRemoteTunnelHostname(params.tunnelHostname);
        const requestHostname = normalizeManagedRemoteTunnelHostname(params.hostname);
        const hostnameFromSettings = normalizeManagedRemoteTunnelHostname(settings?.managedRemoteTunnelHostname);
        const hostname = requestHostname || requestTunnelHostname || requestManagedRemoteHostname || hostnameFromSettings;

        const requestManagedRemoteToken = typeof body.managedRemoteTunnelToken === 'string'
          ? body.managedRemoteTunnelToken.trim()
          : '';
        const requestTunnelToken = typeof body.tunnelToken === 'string'
          ? body.tunnelToken.trim()
          : '';
        const requestToken = typeof body.token === 'string'
          ? body.token.trim()
          : '';
        const requestTokenProvided = body.managedRemoteTunnelTokenProvided === true
          || body.tunnelTokenProvided === true
          || body.tokenProvided === true;
        const requestHostnameProvided = body.managedRemoteTunnelHostnameProvided === true
          || body.tunnelHostnameProvided === true
          || body.hostnameProvided === true;
        const storedManagedRemoteToken = typeof settings?.managedRemoteTunnelToken === 'string'
          ? settings.managedRemoteTunnelToken.trim()
          : '';
        const managedRemoteTunnelConfig = await readManagedRemoteTunnelConfigFromDisk();
        const serverHasSavedManagedRemoteProfile = managedRemoteTunnelConfig.tunnels.some((entry) => {
          const savedHostname = normalizeManagedRemoteTunnelHostname(entry?.hostname);
          const savedToken = typeof entry?.token === 'string' ? entry.token.trim() : '';
          return Boolean(savedHostname && savedToken);
        });
        const cliHasSavedManagedRemoteProfile = params.hasSavedManagedRemoteProfile === '1';
        const hasSavedManagedRemoteProfile = serverHasSavedManagedRemoteProfile || cliHasSavedManagedRemoteProfile;
        const configManagedRemoteToken = providerId === TUNNEL_PROVIDER_CLOUDFLARE
          ? await resolveManagedRemoteTunnelToken({ presetId: selectedPresetId, hostname })
          : '';
        const runtimeHostname = getRuntimeManagedRemoteTunnelHostname();
        const runtimeToken = getRuntimeManagedRemoteTunnelToken();
        const token = requestToken
          || requestTunnelToken
          || requestManagedRemoteToken
          || ((runtimeHostname && hostname && runtimeHostname === hostname) ? runtimeToken : '')
          || configManagedRemoteToken
          || storedManagedRemoteToken;

        const doctorRequest = {
          mode: modeFilter,
          hostname,
          token,
          tokenProvided: requestTokenProvided,
          hostnameProvided: requestHostnameProvided,
          configPath: requestConfigPath,
          hasSavedManagedRemoteProfile,
          originPort: normalizeManagedRemoteOriginPort(params.originPort),
        };

        const result = await runTunnelDoctor({
          providerId,
          modeFilter,
          doctorRequest,
        });
        return res.json(result);
      } catch (error) {
        if (error instanceof TunnelServiceError) {
          return res.status(400).json({ ok: false, error: error.message, code: error.code });
        }
        console.warn('Tunnel doctor failed:', error);
        return res.status(500).json({ ok: false, error: 'Failed to run tunnel doctor' });
      }
    };
    app.post('/api/openchamber/tunnel/doctor', handleTunnelDoctor);
    app.get('/api/openchamber/tunnel/doctor', handleTunnelDoctor);

    app.get('/api/openchamber/tunnel/providers', (_req, res) => {
      const providers = tunnelProviderRegistry.listCapabilities();
      return res.json({ providers });
    });

    app.get('/api/openchamber/tunnel/status', async (_req, res) => {
      try {
        await tunnelService.refreshHealth?.({ maxAgeMs: 5000 });
        const runtimeReady = Boolean(getRuntimeReady());
        const settings = await readSettingsFromDiskMigrated();
        const normalizedMode = normalizeTunnelMode(settings?.tunnelMode);
        const managedRemoteHostname = normalizeManagedRemoteTunnelHostname(settings?.managedRemoteTunnelHostname);
        const managedRemoteTunnelConfig = await readManagedRemoteTunnelConfigFromDisk();
        const managedRemoteTunnelPresetSummaries = managedRemoteTunnelConfig.tunnels.map((entry) => ({
          id: entry.id,
          name: entry.name,
          hostname: entry.hostname,
          originPort: entry.originPort,
        }));
        const selectedManagedRemotePreset = managedRemoteTunnelConfig.tunnels.find(
          (entry) => entry.id === settings?.managedRemoteTunnelSelectedPresetId
        ) || managedRemoteTunnelConfig.tunnels[0] || null;
        const configuredOriginPort = selectedManagedRemotePreset?.originPort
          ?? normalizeManagedRemoteOriginPort(undefined);
        const hasStoredManagedRemoteToken = typeof settings?.managedRemoteTunnelToken === 'string' && settings.managedRemoteTunnelToken.trim().length > 0;
        const hasManagedRemoteTunnelToken = getRuntimeManagedRemoteTunnelToken().length > 0 || managedRemoteTunnelConfig.tunnels.length > 0 || hasStoredManagedRemoteToken;
        const bootstrapTtlMs = settings?.tunnelBootstrapTtlMs === null
          ? null
          : normalizeTunnelBootstrapTtlMs(settings?.tunnelBootstrapTtlMs);
        const sessionTtlMs = normalizeTunnelSessionTtlMs(settings?.tunnelSessionTtlMs);
        const activeSessions = tunnelAuthController.listTunnelSessions();
        const activeProvider = tunnelService.resolveActiveProvider();
        const provider = activeProvider || normalizeTunnelProvider(settings?.tunnelProvider);

        const publicUrl = tunnelService.getPublicUrl();
        if (!publicUrl) {
          return res.json({
            active: false,
            url: null,
            mode: normalizedMode,
            provider,
            providerMetadata: null,
            originPort: configuredOriginPort,
            hasManagedRemoteTunnelToken,
            managedRemoteTunnelHostname: managedRemoteHostname || null,
            managedRemoteTunnelPresets: managedRemoteTunnelPresetSummaries,
            managedRemoteTunnelTokenPresetIds: managedRemoteTunnelConfig.tunnels.map((entry) => entry.id),
            hasBootstrapToken: false,
            bootstrapExpiresAt: null,
            runtimeReady,
            connectReady: false,
            policy: 'tunnel-gated',
            activeTunnelMode: tunnelAuthController.getActiveTunnelMode() || null,
            activeSessions,
            localPort: getActivePort(),
            ttlConfig: {
              bootstrapTtlMs,
              sessionTtlMs,
            },
          });
        }

        const activeNormalizedMode = resolveActiveNormalizedTunnelMode();
        const activeTunnelId = tunnelAuthController.getActiveTunnelId();
        const activeTunnelHost = tunnelAuthController.getActiveTunnelHost();
        const resolvedTunnelHost = resolveNormalizedTunnelHost(publicUrl);
        const activeTunnelMode = tunnelAuthController.getActiveTunnelMode();
        const needsActiveTunnelSync = !activeTunnelId
          || !activeTunnelHost
          || !resolvedTunnelHost
          || activeTunnelHost !== resolvedTunnelHost
          || activeTunnelMode !== activeNormalizedMode;
        if (needsActiveTunnelSync) {
          tunnelAuthController.setActiveTunnel({
            tunnelId: activeTunnelId || crypto.randomUUID(),
            publicUrl,
            mode: activeNormalizedMode,
          });
        }

        const bootstrapStatus = tunnelAuthController.getBootstrapStatus();
        const providerMetadata = tunnelService.getProviderMetadata();
        const connectorHealthy = providerMetadata?.connectorState !== 'degraded';
        const connectReady = runtimeReady && connectorHealthy && bootstrapStatus.hasBootstrapToken;

        return res.json({
          active: true,
          url: publicUrl,
          mode: activeNormalizedMode,
          provider,
          providerMetadata,
          originPort: providerMetadata?.originPort ?? configuredOriginPort,
          hasManagedRemoteTunnelToken,
          managedRemoteTunnelHostname: managedRemoteHostname || null,
          managedRemoteTunnelPresets: managedRemoteTunnelPresetSummaries,
          managedRemoteTunnelTokenPresetIds: managedRemoteTunnelConfig.tunnels.map((entry) => entry.id),
          hasBootstrapToken: bootstrapStatus.hasBootstrapToken,
          bootstrapExpiresAt: bootstrapStatus.bootstrapExpiresAt,
          runtimeReady,
          connectReady,
          policy: 'tunnel-gated',
          activeTunnelMode: activeNormalizedMode,
          activeSessions: tunnelAuthController.listTunnelSessions(),
          localPort: getActivePort(),
          ttlConfig: {
            bootstrapTtlMs,
            sessionTtlMs,
          },
        });
      } catch (error) {
        return res.status(500).json({ error: 'Failed to get tunnel status' });
      }
    });

    app.put('/api/openchamber/tunnel/managed-remote-token', async (req, res) => {
      try {
        const presetId = typeof req?.body?.presetId === 'string' ? req.body.presetId.trim() : '';
        const presetName = typeof req?.body?.presetName === 'string' ? req.body.presetName.trim() : '';
        const managedRemoteTunnelHostname = normalizeManagedRemoteTunnelHostname(req?.body?.managedRemoteTunnelHostname);
        const managedRemoteTunnelToken = typeof req?.body?.managedRemoteTunnelToken === 'string' ? req.body.managedRemoteTunnelToken.trim() : '';
        const originPortInput = req?.body?.originPort ?? req?.body?.managedRemoteTunnelOriginPort;
        const originPort = originPortInput === undefined
          ? normalizeManagedRemoteOriginPort(undefined)
          : (typeof originPortInput === 'string' ? Number(originPortInput.trim()) : originPortInput);

        if (!presetId || !presetName || !managedRemoteTunnelHostname || !managedRemoteTunnelToken || !isValidManagedRemoteOriginPort(originPort)) {
          return res.status(400).json({ ok: false, error: 'presetId, presetName, managedRemoteTunnelHostname, managedRemoteTunnelToken and a valid originPort are required' });
        }

        await upsertManagedRemoteTunnelToken({
          id: presetId,
          name: presetName,
          hostname: managedRemoteTunnelHostname,
          originPort,
          token: managedRemoteTunnelToken,
        });

        const managedRemoteTunnelConfig = await readManagedRemoteTunnelConfigFromDisk();
        return res.json({ ok: true, managedRemoteTunnelTokenPresetIds: managedRemoteTunnelConfig.tunnels.map((entry) => entry.id) });
      } catch (error) {
        if (error instanceof ManagedRemoteTunnelTokenValidationError) {
          return res.status(400).json({ ok: false, error: error.message });
        }
        return res.status(500).json({ ok: false, error: 'Failed to save managed remote tunnel token' });
      }
    });

    app.post('/api/openchamber/tunnel/start', async (_req, res) => {
      try {
        if (!getRuntimeReady()) {
          return res.status(503).json({
            ok: false,
            code: 'runtime_not_ready',
            error: 'DevRyan is still starting. Wait for OpenCode to become ready before starting a tunnel.',
            details: null,
          });
        }
        const settings = await readSettingsFromDiskMigrated();
        if (typeof _req?.body?.provider === 'string' && _req.body.provider.trim().length > 0) {
          const rawProvider = _req.body.provider.trim().toLowerCase();
          if (!tunnelProviderRegistry.get(rawProvider)) {
            return res.status(422).json({ ok: false, error: `Unsupported tunnel provider: ${rawProvider}`, code: 'provider_unsupported' });
          }
        }
        const provider = normalizeTunnelProvider(_req?.body?.provider ?? settings?.tunnelProvider);
        const modeInput = _req?.body?.mode ?? settings?.tunnelMode;
        const intent = typeof _req?.body?.intent === 'string' ? _req.body.intent.trim().toLowerCase() : undefined;
        const mode = typeof modeInput === 'string'
          ? modeInput.trim().toLowerCase()
          : normalizeTunnelMode(modeInput);
        if (typeof _req?.body?.mode === 'string' && _req.body.mode.trim().length > 0 && !isSupportedTunnelMode(mode)) {
          return res.status(422).json({ ok: false, error: `Unsupported tunnel mode: ${mode}`, code: 'mode_unsupported' });
        }
        const selectedPresetId = typeof _req?.body?.managedRemoteTunnelPresetId === 'string' ? _req.body.managedRemoteTunnelPresetId.trim() : '';
        const selectedPresetName = typeof _req?.body?.managedRemoteTunnelPresetName === 'string' ? _req.body.managedRemoteTunnelPresetName.trim() : '';
        const requestConfigPath = normalizeOptionalPath(_req?.body?.configPath)
          ?? normalizeOptionalPath(settings?.managedLocalTunnelConfigPath);
        const requestManagedRemoteHostname = normalizeManagedRemoteTunnelHostname(_req?.body?.managedRemoteTunnelHostname);
        const requestTunnelHostname = normalizeManagedRemoteTunnelHostname(_req?.body?.tunnelHostname);
        const requestHostname = normalizeManagedRemoteTunnelHostname(_req?.body?.hostname);
        const hostnameFromSettings = normalizeManagedRemoteTunnelHostname(settings?.managedRemoteTunnelHostname);
        const hostname = requestHostname || requestTunnelHostname || requestManagedRemoteHostname || hostnameFromSettings;
        const configuredManagedRemotePreset = provider === TUNNEL_PROVIDER_CLOUDFLARE
          ? await resolveManagedRemoteTunnelPreset({ presetId: selectedPresetId, hostname })
          : null;
        const rawOriginPort = _req?.body?.originPort
          ?? _req?.body?.managedRemoteTunnelOriginPort
          ?? configuredManagedRemotePreset?.originPort;
        const originPort = rawOriginPort === undefined || rawOriginPort === null || rawOriginPort === ''
          ? normalizeManagedRemoteOriginPort(undefined)
          : (typeof rawOriginPort === 'string' ? Number(rawOriginPort.trim()) : rawOriginPort);
        const requestManagedRemoteToken = typeof _req?.body?.managedRemoteTunnelToken === 'string' ? _req.body.managedRemoteTunnelToken.trim() : '';
        const requestTunnelToken = typeof _req?.body?.tunnelToken === 'string' ? _req.body.tunnelToken.trim() : '';
        const requestToken = typeof _req?.body?.token === 'string' ? _req.body.token.trim() : '';
        const storedManagedRemoteToken = typeof settings?.managedRemoteTunnelToken === 'string' ? settings.managedRemoteTunnelToken.trim() : '';
        const configManagedRemoteToken = configuredManagedRemotePreset?.token
          || (provider === TUNNEL_PROVIDER_CLOUDFLARE
            ? await resolveManagedRemoteTunnelToken({ presetId: selectedPresetId, hostname })
            : '');
        const runtimeHostname = getRuntimeManagedRemoteTunnelHostname();
        const runtimeToken = getRuntimeManagedRemoteTunnelToken();
        const token = requestToken
          || requestTunnelToken
          || requestManagedRemoteToken
          || ((runtimeHostname && hostname && runtimeHostname === hostname) ? runtimeToken : '')
          || configManagedRemoteToken
          || storedManagedRemoteToken;
        const requestConnectTtlMs = typeof _req?.body?.connectTtlMs === 'number' && Number.isFinite(_req.body.connectTtlMs)
          ? normalizeTunnelBootstrapTtlMs(_req.body.connectTtlMs)
          : undefined;
        const requestSessionTtlMs = typeof _req?.body?.sessionTtlMs === 'number' && Number.isFinite(_req.body.sessionTtlMs)
          ? normalizeTunnelSessionTtlMs(_req.body.sessionTtlMs)
          : undefined;
        const bootstrapTtlMs = requestConnectTtlMs ?? (settings?.tunnelBootstrapTtlMs === null
          ? null
          : normalizeTunnelBootstrapTtlMs(settings?.tunnelBootstrapTtlMs));
        const sessionTtlMs = requestSessionTtlMs ?? normalizeTunnelSessionTtlMs(settings?.tunnelSessionTtlMs);

        const previousTunnelId = tunnelAuthController.getActiveTunnelId();
        const previousMode = tunnelAuthController.getActiveTunnelMode();
        const previousProvider = tunnelService.resolveActiveProvider();
        const previousUrl = tunnelService.getPublicUrl();

        const { publicUrl, provider: activeProvider, providerMetadata, controllerReused } = await startTunnelWithNormalizedRequest({
          provider,
          mode,
          intent,
          hostname,
          token,
          configPath: requestConfigPath,
          selectedPresetId,
          selectedPresetName,
          originPort,
        });

        const replacedTunnel = Boolean(previousTunnelId) && (
          !controllerReused
          ||
          previousMode !== mode
          || previousProvider !== activeProvider
          || previousUrl !== publicUrl
        );
        let revokedBootstrapCount = 0;
        let invalidatedSessionCount = 0;
        if (replacedTunnel && previousTunnelId) {
          const revoked = tunnelAuthController.revokeTunnelArtifacts(previousTunnelId);
          revokedBootstrapCount = revoked.revokedBootstrapCount;
          invalidatedSessionCount = revoked.invalidatedSessionCount;
        }

        tunnelAuthController.setActiveTunnel({
          tunnelId: replacedTunnel || !previousTunnelId ? crypto.randomUUID() : previousTunnelId,
          publicUrl,
          mode,
        });

        const bootstrapToken = tunnelAuthController.issueBootstrapToken({ ttlMs: bootstrapTtlMs });
        const connectUrl = `${publicUrl.replace(/\/$/, '')}/tunnel/connect?t=${encodeURIComponent(bootstrapToken.token)}`;
        const managedRemoteTunnelConfig = await readManagedRemoteTunnelConfigFromDisk();
        const isCloudflareProvider = activeProvider === TUNNEL_PROVIDER_CLOUDFLARE;

        return res.json({
          ok: true,
          url: publicUrl,
          mode,
          provider: activeProvider,
          providerMetadata,
          originPort: providerMetadata?.originPort ?? originPort,
          managedRemoteTunnelHostname: isCloudflareProvider ? (hostname || null) : null,
          managedRemoteTunnelTokenPresetIds: isCloudflareProvider ? managedRemoteTunnelConfig.tunnels.map((entry) => entry.id) : [],
          connectUrl,
          bootstrapExpiresAt: bootstrapToken.expiresAt,
          runtimeReady: true,
          connectReady: providerMetadata?.connectorState !== 'degraded',
          replacedTunnel,
          replaced: replacedTunnel
            ? {
              mode: previousMode,
              provider: previousProvider,
              url: previousUrl,
            }
            : null,
          revokedBootstrapCount,
          invalidatedSessionCount,
          policy: 'tunnel-gated',
          activeTunnelMode: mode,
          activeSessions: tunnelAuthController.listTunnelSessions(),
          localPort: getActivePort(),
          ttlConfig: {
            bootstrapTtlMs,
            sessionTtlMs,
          },
        });
      } catch (error) {
        console.error('Failed to start tunnel:', error);
        if (!getActiveTunnelController()) {
          tunnelAuthController.clearActiveTunnel();
        }
        if (error instanceof TunnelServiceError) {
          const status = error.code === 'missing_dependency'
            ? 400
            : (error.code === 'runtime_not_ready'
              ? 503
            : (error.code === 'validation_error' || error.code === 'provider_unsupported' || error.code === 'mode_unsupported'
              ? 422
              : 500));
          return res.status(status).json({ ok: false, error: error.message, code: error.code, details: error.details ?? null });
        }
        const safeDetails = error && typeof error === 'object' && error.details && typeof error.details === 'object'
          ? error.details
          : null;
        const errorCode = error && typeof error === 'object' && typeof error.code === 'string'
          ? error.code
          : 'startup_failed';
        const errorMessage = error instanceof Error && error.message.trim().length > 0
          ? error.message
          : 'Failed to start tunnel';
        const status = errorCode === 'managed_remote_origin_port_in_use'
          ? 409
          : (errorCode === 'managed_remote_public_unreachable' ? 502 : 500);
        return res.status(status).json({ ok: false, error: errorMessage, code: errorCode, details: safeDetails });
      }
    });

    app.post('/api/openchamber/tunnel/stop', async (_req, res) => {
      let revokedBootstrapCount = 0;
      let invalidatedSessionCount = 0;
      const activeTunnelId = tunnelAuthController.getActiveTunnelId();

      if (getActiveTunnelController()) {
        console.log('Stopping active tunnel (user requested)...');
        try {
          await tunnelService.stop();
        } catch (error) {
          console.error('Failed to stop active tunnel:', error);
          return res.status(500).json({
            ok: false,
            error: error instanceof Error ? error.message : 'Failed to stop active tunnel',
            code: 'tunnel_stop_failed',
          });
        }
      }

      if (activeTunnelId) {
        const revoked = tunnelAuthController.revokeTunnelArtifacts(activeTunnelId);
        revokedBootstrapCount = revoked.revokedBootstrapCount;
        invalidatedSessionCount = revoked.invalidatedSessionCount;
      }

      tunnelAuthController.clearActiveTunnel();
      res.json({ ok: true, revokedBootstrapCount, invalidatedSessionCount });
    });
  };

  return {
    registerRoutes,
    startTunnelWithNormalizedRequest,
  };
};
