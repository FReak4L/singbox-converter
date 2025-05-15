document.addEventListener('DOMContentLoaded', () => {
    const inputLinksEl = document.getElementById('inputLinks');
    const configNameEl = document.getElementById('configName');
    const convertBtn = document.getElementById('convertBtn');
    const outputConfigEl = document.getElementById('outputConfig');
    const copyBtn = document.getElementById('copyBtn');
    const downloadBtn = document.getElementById('downloadBtn');
    const saveConfigBtn = document.getElementById('saveConfigBtn');
    const savedConfigsListEl = document.getElementById('savedConfigsList');

    let currentGeneratedConfig = null;

    convertBtn.addEventListener('click', handleConversion);
    copyBtn.addEventListener('click', copyConfig);
    downloadBtn.addEventListener('click', downloadConfig);
    saveConfigBtn.addEventListener('click', saveCurrentConfig);

    loadSavedConfigs();

    // Initialize the first tab based on the 'active' class in HTML
    const firstActiveTabButton = document.querySelector('.tab-button.active');
    if (firstActiveTabButton) {
        // Extract tabName from onclick attribute, e.g., "openTab(event, 'converter')"
        const tabNameMatch = firstActiveTabButton.getAttribute('onclick').match(/'([^']+)'/);
        if (tabNameMatch && tabNameMatch[1]) {
            openTab({ currentTarget: firstActiveTabButton }, tabNameMatch[1]);
        }
    }


    async function handleConversion() {
        const linksText = inputLinksEl.value.trim();
        if (!linksText) {
            alert('لطفاً حداقل یک لینک پروکسی یا لینک اشتراک وارد کنید.');
            return;
        }

        outputConfigEl.value = 'در حال پردازش، لطفاً صبر کنید...';
        convertBtn.disabled = true;
        convertBtn.textContent = 'درحال تبدیل...'; // Update button text while processing
        copyBtn.disabled = true;
        downloadBtn.disabled = true;
        saveConfigBtn.disabled = true;

        try {
            const lines = linksText.split('\n').map(line => line.trim()).filter(line => line);
            let allOutbounds = [];

            for (const line of lines) {
                if (line.startsWith('http://') || line.startsWith('https://')) {
                    try {
                        const subOutbounds = await processSubscriptionLink(line);
                        allOutbounds.push(...subOutbounds.filter(ob => ob !== null));
                    } catch (error) {
                        console.error(`Error processing subscription ${line}:`, error);
                        alert(`خطا در پردازش لینک اشتراک ${line}: ${error.message}`);
                    }
                } else {
                    try {
                        const outbound = parseProxyLink(line);
                        if (outbound) {
                            allOutbounds.push(outbound);
                        }
                    } catch (error) {
                        console.error(`Error processing link ${line}:`, error.message);
                        // Consider a less intrusive way to show per-link errors
                        // For example, collect errors and show them at the end or in a dedicated area
                    }
                }
            }

            if (allOutbounds.length > 0) {
                currentGeneratedConfig = generateFullSingBoxConfig(allOutbounds);
                outputConfigEl.value = JSON.stringify(currentGeneratedConfig, null, 2);
                copyBtn.disabled = false;
                downloadBtn.disabled = false;
                saveConfigBtn.disabled = false;
            } else {
                outputConfigEl.value = 'هیچ پروکسی معتبری برای تبدیل یافت نشد یا در پردازش اشتراک‌ها خطایی رخ داد.';
                // No alert here to avoid being too intrusive if input is empty or sub fails silently
            }

        } catch (error) { // Catch errors from generateFullSingBoxConfig or other general issues
            console.error('General conversion error:', error);
            outputConfigEl.value = `خطای کلی در تبدیل: ${error.message}`;
        } finally {
            convertBtn.disabled = false;
            convertBtn.textContent = 'تبدیل به کانفیگ Sing-Box'; // Reset button text
        }
    }

    async function processSubscriptionLink(url) {
        const outbounds = [];
        try {
            const response = await fetch(`https://api.allorigins.win/get?url=${encodeURIComponent(url)}`);
            if (!response.ok) {
                let errorMsg = `Network response was not ok for subscription: ${response.status}`;
                try {
                    const errorData = await response.json();
                    errorMsg += ` - ${errorData?.contents || response.statusText}`;
                } catch (e) { /* ignore if response is not json */ }
                throw new Error(errorMsg);
            }
            const data = await response.json();
            if (!data.contents) {
                throw new Error('CORS proxy did not return content (data.contents is null/undefined).');
            }
            const decodedContent = atob(data.contents);
            const links = decodedContent.split('\n').map(link => link.trim()).filter(link => link);

            for (const link of links) {
                try {
                    const outbound = parseProxyLink(link);
                    if (outbound) {
                        outbounds.push(outbound);
                    }
                } catch (e) {
                    console.warn(`Skipping invalid or unparsable link in subscription: "${link.substring(0,30)}..."`, e.message);
                }
            }
        } catch (error) {
            console.error(`Failed to fetch or parse subscription from ${url}:`, error);
            // Re-throw to be caught by handleConversion and potentially shown to user
            throw new Error(`دریافت یا پردازش اشتراک ${url} ناموفق بود: ${error.message}`);
        }
        return outbounds;
    }
    
    function sanitizeTag(tag) {
        if (typeof tag !== 'string') tag = String(tag);
        let sanitized = tag.replace(/[^\p{L}\p{N}\p{Z}\p{P}_ -]/gu, '').trim(); // Allow letters, numbers, spaces, basic punctuation, underscore, hyphen
        sanitized = sanitized.replace(/\s+/g, '_').replace(/[|()[\]{}:;"'<>,.?/~`!@#$%^&*+=]/g, '_'); // Replace spaces & most special chars with underscores
        sanitized = sanitized.replace(/__+/g, '_'); // Replace multiple underscores with single
        sanitized = sanitized.replace(/^_+|_+$/g, ''); // Trim underscores from start/end
        return sanitized.slice(0, 50) || `proxy_tag_${Date.now()%10000}`; // Ensure a tag exists and limit length
    }


    function parseProxyLink(link) {
        if (link.startsWith('vless://')) {
            return parseVlessLink(link);
        } else if (link.startsWith('vmess://')) {
            return parseVmessLink(link);
        } else if (link.startsWith('hysteria2://') || link.startsWith('hy2://')) {
            return parseHysteria2Link(link);
        } else {
            console.warn(`Unsupported link format provided: ${link.substring(0,30)}...`);
            return null; // Explicitly return null for unsupported links
        }
    }

    function parseVlessLink(link) {
        const url = new URL(link);
        const params = new URLSearchParams(url.search);
        const remark = decodeURIComponent(url.hash.substring(1)) || `vless_${url.hostname}_${url.port || 'default'}`;
        const tag = sanitizeTag(remark);

        const security = params.get('security');
        const encryption = params.get('encryption'); // This is key for VLESS TCP without TLS
        const type = params.get('type'); // Transport type

        const outbound = {
            type: "vless",
            tag: tag,
            server: url.hostname,
            server_port: parseInt(url.port) || (security === 'tls' || security === 'reality' ? 443 : 80), // Default port based on security
            uuid: url.username,
        };
        
        // TLS Configuration
        if (security === 'tls' || security === 'reality') {
            outbound.tls = {
                enabled: true,
                server_name: params.get('sni') || params.get('host') || url.hostname, // SNI is crucial
                utls: { // uTLS fingerprint
                    enabled: true,
                    fingerprint: params.get('fp') || "chrome"
                }
            };
            if (security === 'reality') {
                outbound.tls.reality = {
                    enabled: true,
                    public_key: params.get('pbk'),
                    short_id: params.get('sid') || ""
                };
                // Note: Some REALITY setups might not need/want uTLS. For simplicity, we include it.
                // If issues arise, consider `delete outbound.tls.utls;` for REALITY.
            }
        } else if ((!security || security === "" || security === "none") && encryption === "none") {
            // This is for VLESS over TCP without TLS (e.g., `security=` or `security=none` AND `encryption=none`)
            outbound.encryption = "none"; // This is mandatory for sing-box
        }
        // If security is something else, or encryption is not 'none' for non-TLS, it's ambiguous or not standard VLESS.
        // Sing-box will likely default to no TLS if `tls` object is missing.

        // Flow (XTLS related, typically used with TLS/REALITY)
        const flow = params.get('flow');
        if (flow && (security === 'tls' || security === 'reality')) {
            outbound.flow = flow;
        }
        
        // Transport Protocol
        if (type) {
            outbound.transport = { type: type };
            if (type === 'ws') {
                outbound.transport.path = params.get('path') || "/";
                outbound.transport.headers = { Host: params.get('host') || url.hostname }; // 'host' param is for WS Host header
                // `early_data_header_name` and `max_early_data` could be added if link has 0-RTT hints.
            } else if (type === 'grpc') {
                outbound.transport.service_name = params.get('serviceName') || "";
            } else if (type === 'tcp') {
                // The 'headerType=http' from some V2Ray VLESS links is specific to V2Ray's "obfuscation" and not standard for sing-box VLESS TCP.
                // If it's truly HTTP obfuscation, a different outbound type or a plugin might be needed, which is beyond simple VLESS.
                // For plain TCP, no extra transport params usually.
            }
            // Other types like 'h2', 'quic' could be added here.
        } else {
             // Default to TCP if no transport type is specified
             outbound.transport = { type: "tcp" };
        }
        
        return outbound;
    }

    function parseVmessLink(link) {
        const base64Config = link.substring(8);
        let vmessConfig;
        try {
            const configStr = atob(base64Config);
            vmessConfig = JSON.parse(configStr);
        } catch (e) {
            console.error("Error decoding or parsing VMess link:", e, "Input:", link);
            throw new Error(`لینک VMess نامعتبر یا قابل رمزگشایی نیست: ${link.substring(0, 25)}...`);
        }

        const remark = vmessConfig.ps || `vmess_${vmessConfig.add}_${vmessConfig.port || 'default'}`;
        const tag = sanitizeTag(remark);

        const outbound = {
            type: "vmess",
            tag: tag,
            server: vmessConfig.add,
            server_port: parseInt(vmessConfig.port),
            uuid: vmessConfig.id,
            alter_id: parseInt(vmessConfig.aid) || 0,
            security: vmessConfig.scy || vmessConfig.security || "auto", // 'security' is the old name, 'scy' is newer
        };

        // TLS settings for VMess
        if (vmessConfig.tls === 'tls' || vmessConfig.tls === 'reality' || ((vmessConfig.net === 'ws' || vmessConfig.net === 'h2') && (vmessConfig.host || vmessConfig.sni))) {
             outbound.tls = {
                enabled: true,
                server_name: vmessConfig.sni || vmessConfig.host || vmessConfig.add, // SNI from 'sni' or 'host'
                utls: {
                    enabled: true,
                    fingerprint: vmessConfig.fp || "chrome"
                }
            };
            if(vmessConfig.tls === 'reality'){ // REALITY for VMess is less common but possible
                 outbound.tls.reality = {
                    enabled: true,
                    public_key: vmessConfig.pbk,
                    short_id: vmessConfig.sid || ""
                };
            }
        }

        // Transport settings for VMess
        if (vmessConfig.net && vmessConfig.net !== 'tcp') {
            outbound.transport = { type: vmessConfig.net };
            if (vmessConfig.net === 'ws') {
                outbound.transport.path = vmessConfig.path || "/";
                outbound.transport.headers = { Host: vmessConfig.host || vmessConfig.add };
            } else if (vmessConfig.net === 'grpc') {
                // For gRPC, 'path' in vmess often means serviceName.
                outbound.transport.service_name = vmessConfig.path || vmessConfig.serviceName || "";
                // Can also set grpc_multi_mode if specified, e.g. vmessConfig.multi === 'true'
            } else if (vmessConfig.net === 'h2') { // HTTP/2 transport
                outbound.transport.path = vmessConfig.path || "/";
                outbound.transport.host = [vmessConfig.host || vmessConfig.add]; // host is an array in sing-box h2 transport
            }
            // QUIC, etc. can be added
        } else {
            // Default to TCP if 'net' is 'tcp' or not specified
            outbound.transport = { type: "tcp" };
        }
        
        return outbound;
    }

    function parseHysteria2Link(link) {
        const url = new URL(link.replace(/^hy2:\/\//, 'hysteria2://')); // Normalize hy2 to hysteria2
        const params = new URLSearchParams(url.search);
        const remark = decodeURIComponent(url.hash.substring(1)) || `hy2_${url.hostname}_${url.port}`;
        const tag = sanitizeTag(remark);

        const outbound = {
            type: "hysteria2",
            tag: tag,
            server: url.hostname,
            server_port: parseInt(url.port),
            // Hysteria2 uses 'auth' in URL for password, URL parser might put it in username or password
            password: url.username || url.password || "", 
            // Mbps values, provide sensible defaults
            up_mbps: parseInt(params.get('upmbps') || params.get('up')) || 20, 
            down_mbps: parseInt(params.get('downmbps') || params.get('down')) || 100, 
            tls: {
                enabled: true, // Hysteria2 is always TLS based
                server_name: params.get('sni') || url.hostname,
                // Hysteria2 handles its own fingerprinting/utls internally,
                // but sing-box 'tls' object can still have 'utls' for consistency or specific needs.
                // It might be ignored by the Hysteria2 handler.
                utls: { 
                    enabled: params.get('utls_enabled') === 'true', // Default to false unless specified
                    fingerprint: params.get('fp') || "chrome" 
                },
                insecure: params.get('insecure') === '1' || params.get('allowInsecure') === '1', 
                alpn: params.get('alpn') ? params.get('alpn').split(',') : ["h3"], // Default to h3, allow comma-separated ALPNs
            }
        };
        
        // Obfuscation (e.g., Salamander)
        const obfsType = params.get('obfs');
        if (obfsType) {
            // sing-box Hysteria2 outbound uses "obfs" object for password, not a top-level "obfs_password"
            outbound.obfs = { 
                type: obfsType, // e.g. "salamander"
                password: params.get('obfs-password') || params.get('obfs_password') || ""
            };
        }
        
        // Other Hysteria2 specific params can be added here if found in the link, e.g.,
        // recv_window_conn, recv_window, fast_open, etc.
        // Example: if (params.has('fast_open')) outbound.fast_open = params.get('fast_open') === '1';

        return outbound;
    }


    function generateFullSingBoxConfig(outbounds) {
        const uniqueOutbounds = [];
        const seenTags = new Set();
        let tagCounter = 1;

        // Add standard outbounds first and track their tags
        const standardOutbounds = [
            { type: "direct", tag: "direct" },
            { type: "block", tag: "block" },
            { type: "dns", tag: "dns-out"} // Dedicated DNS outbound
        ];

        for (const std_ob of standardOutbounds) {
            uniqueOutbounds.push(std_ob);
            seenTags.add(std_ob.tag); // Track standard tags
        }

        // Process and add proxy outbounds, ensuring unique tags
        const proxyOutbounds = []; // Store only actual proxy servers here
        for (const outbound of outbounds) {
            if (!outbound || !outbound.tag) continue; // Skip if outbound is null or has no tag
            
            let newTag = outbound.tag; // Tag is already sanitized by parse functions
            while (seenTags.has(newTag)) { // Ensure tag is unique across ALL outbounds
                newTag = `${outbound.tag}_${tagCounter++}`;
            }
            outbound.tag = newTag;
            seenTags.add(newTag);
            proxyOutbounds.push(outbound); // Add to the list of proxy servers
        }
        
        uniqueOutbounds.push(...proxyOutbounds); // Add processed proxy outbounds to the main list

        // Determine the primary outbound for routing (final route)
        const proxyOutboundTags = proxyOutbounds.map(o => o.tag);
        let finalRouteOutboundTag = "direct"; // Default to direct if no proxies

        if (proxyOutboundTags.length > 1) {
            const autoSelectTag = "auto_select_proxies"; // URLTest for proxies
            if (!seenTags.has(autoSelectTag)) { // Ensure this tag is also unique
                uniqueOutbounds.push({
                    type: "urltest",
                    tag: autoSelectTag,
                    outbounds: proxyOutboundTags, // Test only the proxy servers
                    url: "http://www.gstatic.com/generate_204", // Standard connectivity check URL
                    interval: "10m", // Test every 10 minutes
                    tolerance: 200 // Switch if new best is 200ms faster
                });
                seenTags.add(autoSelectTag);
                finalRouteOutboundTag = autoSelectTag; // Use URLTest as final outbound
            } else { 
                // Fallback if auto_select_proxies somehow exists (highly unlikely with this logic)
                finalRouteOutboundTag = proxyOutboundTags[0]; // Use the first proxy
            }
        } else if (proxyOutboundTags.length === 1) {
            finalRouteOutboundTag = proxyOutboundTags[0]; // Use the single proxy
        }
        
        // Determine detour for external DNS queries (use the selected proxy or direct)
        const dnsQueryDetour = (finalRouteOutboundTag !== "direct" && seenTags.has(finalRouteOutboundTag)) ? finalRouteOutboundTag : "direct";


        return {
            log: {
                // disabled: false, // By default, logging is enabled if not specified
                level: "info", // Common levels: error, warn, info, debug, trace
                // output: "sing-box.log", // Path to log file (if not running as service with own logging)
                timestamp: true
            },
            dns: {
                servers: [
                    // External DNS (TLS or DoH for privacy) - routed via selected proxy or direct
                    { address: "tls://1.1.1.1", tag: "dns_cf_tls", detour: dnsQueryDetour },
                    { address: "https://dns.google/dns-query", tag: "dns_google_doh", detour: dnsQueryDetour },
                    // Local/Iranian DNS (for domestic sites) - always direct
                    { address: "1.0.0.1", tag: "dns_cf_plain_backup", detour: dnsQueryDetour}, // Plain DNS as backup
                    { address: "223.5.5.5", tag: "dns_ali", detour: "direct" }, // Aliyun DNS
                    { address: "185.51.200.2", tag: "dns_shecan", detour: "direct" }, // Shecan DNS
                    { address: "local", tag: "dns_system", detour: "direct" } // System's DNS resolver
                ],
                rules: [
                    // Route DNS for Iranian domains to local DNS servers
                    { geosite: ["category-ir"], server: "dns_ali" },
                    { domain_suffix: [".ir"], server: "dns_ali" },
                    // Default DNS server for other queries (A and AAAA records)
                    { query_type: ["A", "AAAA"], server: "dns_cf_tls", rewrite_ttl: 300 },
                    // Fallback for any other DNS query types or if preferred servers fail
                    { server: "dns_system" } 
                ],
                strategy: "ipv4_only", // Or "prefer_ipv4", "prefer_ipv6"
                // independent_cache: true, // Each DNS server query gets its own cache entry if true
                disable_cache: false, // Enable DNS caching
            },
            inbounds: [
                {
                    type: "tun",
                    tag: "tun-in",
                    interface_name: "NotePadVPN-TUN", // Customizable TUN interface name
                    inet4_address: "172.19.0.1/28", // Small private subnet for TUN
                    // mtu: 1420, // Adjust based on underlying network, 1420 is common for WireGuard/some VPNs
                    auto_route: true, // Automatically add routes to system
                    strict_route: true, // Prevent traffic from bypassing TUN if VPN is active
                    // endpoint_independent_nat: false, // Usually false for better compatibility
                    stack: "mixed", // "gvisor" (more secure, slower) or "system" (faster, less secure for some things)
                    sniff: true, // Enable domain sniffing from packets
                    sniff_override_destination: false // If true, uses sniffed domain for routing, even if IP is different
                },
                {
                    type: "mixed", // HTTP and SOCKS5 on the same port
                    tag: "mixed-proxy-in",
                    listen: "127.0.0.1", // Listen on localhost only
                    listen_port: 2080, // A common proxy port
                    sniff: true,
                    // users: [ { username: "user1", password: "password1" } ] // Optional: add basic auth
                }
            ],
            outbounds: uniqueOutbounds, // Contains direct, block, dns-out, proxies, and urltest
            route: {
                rules: [
                    // Rule 1: Handle all DNS protocol traffic using the "dns-out" outbound.
                    { protocol: ["dns"], outbound: "dns-out" },
                    
                    // Rule 2: Block specific domains or keywords.
                    { domain: ["allatori.com", "analytics.example.com"], outbound: "block" },
                    { domain_keyword: ["ads", "tracker"], outbound: "block"}, // Example keyword blocking

                    // Rule 3: Route Iranian TLDs and common Iranian CDNs/services directly.
                    { domain_suffix: [".ir", "arvancloud.ir", "arvancloud.com", "cdn.ir", "shaparak.ir", "digikala.com"], outbound: "direct" },
                    { geosite: ["category-ir"], outbound: "direct" }, // From geosite database
                    { geoip: ["ir"], outbound: "direct" }, // Based on IP geolocation for Iran

                    // Rule 4: Example for routing specific applications or processes (platform-dependent)
                    // { process_name: ["qbittorrent.exe"], outbound: finalRouteOutboundTag }, // Windows process
                    // { package_name: ["org.telegram.messenger"], outbound: finalRouteOutboundTag }, // Android package

                    // Rule 5: Route LAN traffic direct
                    { ip_cidr: ["192.168.0.0/16", "10.0.0.0/8", "172.16.0.0/12"], outbound: "direct"},
                    { domain: ["localhost"], outbound: "direct"},

                    // Add more specific rules as needed, e.g., for certain game servers, streaming services etc.
                ],
                final: finalRouteOutboundTag, // Default outbound for any traffic not matched by rules
                auto_detect_interface: true, // Allows sing-box to choose the best physical network interface
                override_android_vpn: true, // If on Android, ensures sing-box properly controls the VPN slot
            },
            experimental: { // Experimental features, subject to change
                cache_file: { // DNS cache persistence
                    enabled: true,
                    // path: "dns_cache.json", // File path to store DNS cache (ensure write permissions)
                    // store_fakeip: true, // If using a fake-IP DNS strategy
                },
                // clash_api: { // Enable a Clash-compatible API for external controllers/UIs
                //    external_controller: "0.0.0.0:9090", // Listen address for API (0.0.0.0 for all interfaces)
                //    external_ui: "dashboard-ui", // Path to a web UI (e.g., Yacd, Meta Dashboard)
                //    secret: "", // Optional API access secret
                //    default_mode: "rule" // Initial mode for Clash API ('rule', 'global', 'direct')
                // }
            }
        };
    }

    function copyConfig() {
        if (outputConfigEl.value) {
            navigator.clipboard.writeText(outputConfigEl.value)
                .then(() => alert('کانفیگ با موفقیت کپی شد!'))
                .catch(err => {
                    console.error('Clipboard copy failed:', err);
                    // Fallback for browsers where clipboard API might fail or need permissions
                    prompt("خطا در کپی خودکار. لطفاً با Ctrl+C یا Cmd+C کپی کنید:", outputConfigEl.value);
                });
        }
    }

    function downloadConfig() {
        if (outputConfigEl.value) {
            const blob = new Blob([outputConfigEl.value], { type: 'application/json;charset=utf-8' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            // Sanitize config name for filename
            let fileName = (configNameEl.value.trim().replace(/[^\w\s._-]/g, '') || 'NotePadVPN_SingBox_Config');
            fileName = fileName.replace(/\s+/g, '_'); // Replace spaces with underscores
            a.href = url;
            a.download = fileName + '.json';
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
        }
    }
    
    function saveCurrentConfig() {
        if (!currentGeneratedConfig) {
            alert('هیچ کانفیگی برای ذخیره وجود ندارد. ابتدا یک کانفیگ تولید کنید.');
            return;
        }
        let name = configNameEl.value.trim();
        if (!name) {
            const timestamp = new Date().toLocaleDateString('fa-IR-u-nu-latn', { year: '2-digit', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).replace(/[\s/:]/g, '-').replace(',','_');
            name = prompt('لطفاً یک نام برای این کانفیگ وارد کنید (فقط حروف، اعداد و خط تیره):', `Config_${timestamp}`);
        }
        
        if (name) { // User provided a name or didn't cancel prompt
            const sanitizedName = name.replace(/[^\w\s._-]/g, '').replace(/\s+/g, '_'); // Sanitize name for storage key
            if (!sanitizedName){
                alert("نام وارد شده نامعتبر است.");
                return;
            }
            saveConfigToLocalStorage(sanitizedName, currentGeneratedConfig);
            loadSavedConfigs(); // Refresh the list of saved configs
            alert(`کانفیگ "${sanitizedName}" با موفقیت ذخیره شد.`);
        }
    }

    function saveConfigToLocalStorage(name, config) {
        try {
            // Use a versioned key for localStorage to avoid conflicts if structure changes later
            let savedConfigs = JSON.parse(localStorage.getItem('notepadVPN_SingBoxConfigs_v1.1') || '{}');
            savedConfigs[name] = config; // Overwrite if name exists, or add new
            localStorage.setItem('notepadVPN_SingBoxConfigs_v1.1', JSON.stringify(savedConfigs));
        } catch (e) {
            console.error("Error saving to localStorage:", e);
            alert('خطا در ذخیره کانفیگ. ممکن است حافظه مرورگر پر باشد یا اطلاعات قبلی خراب شده باشد.');
        }
    }

    function loadSavedConfigs() {
        savedConfigsListEl.innerHTML = ''; // Clear current list
        try {
            const savedConfigs = JSON.parse(localStorage.getItem('notepadVPN_SingBoxConfigs_v1.1') || '{}');
            if (Object.keys(savedConfigs).length === 0) {
                savedConfigsListEl.innerHTML = '<p class="empty-state">هیچ کانفیگی تاکنون ذخیره نشده است.</p>';
                return;
            }

            // Create a list item for each saved configuration
            Object.entries(savedConfigs).forEach(([name, configData]) => {
                const item = document.createElement('div');
                item.classList.add('saved-item');
                
                const nameSpan = document.createElement('span');
                nameSpan.textContent = name;
                nameSpan.title = `بارگذاری کانفیگ: ${name}`; // Tooltip

                const actionsDiv = document.createElement('div');
                actionsDiv.classList.add('actions'); // Class for styling action buttons

                const loadButton = document.createElement('button');
                loadButton.classList.add('load', 'secondary-button'); // Use existing button styles
                loadButton.textContent = 'بارگذاری';
                loadButton.dataset.name = name; // Store name in data attribute for easy access
                loadButton.addEventListener('click', (e) => {
                    const configName = e.target.dataset.name;
                    currentGeneratedConfig = savedConfigs[configName]; // Load the config object
                    outputConfigEl.value = JSON.stringify(currentGeneratedConfig, null, 2);
                    configNameEl.value = configName; // Populate name field for potential re-save/download
                    
                    // Enable action buttons for the loaded config
                    copyBtn.disabled = false;
                    downloadBtn.disabled = false;
                    saveConfigBtn.disabled = false; 
                    
                    // Switch to the converter tab to show the loaded config
                    const converterTabButton = document.querySelector('.tab-button[onclick*="\'converter\'"]');
                    if (converterTabButton) {
                        openTab({ currentTarget: converterTabButton }, 'converter', true);
                    }
                    
                    alert(`کانفیگ "${configName}" با موفقیت بارگذاری شد و در تب "تبدیل" نمایش داده می‌شود.`);
                    outputConfigEl.scrollTop = 0; // Scroll to the top of the textarea
                });

                const deleteButton = document.createElement('button');
                deleteButton.classList.add('delete', 'secondary-button');
                deleteButton.textContent = 'حذف';
                deleteButton.dataset.name = name;
                deleteButton.addEventListener('click', (e) => {
                    const configNameToDelete = e.target.dataset.name;
                    if (confirm(`آیا از حذف کانفیگ ذخیره شده با نام "${configNameToDelete}" مطمئن هستید؟ این عمل قابل بازگشت نیست.`)) {
                        delete savedConfigs[configNameToDelete]; // Remove from the object
                        localStorage.setItem('notepadVPN_SingBoxConfigs_v1.1', JSON.stringify(savedConfigs)); // Update localStorage
                        loadSavedConfigs(); // Refresh the displayed list
                        alert(`کانفیگ "${configNameToDelete}" حذف شد.`);
                    }
                });
                
                actionsDiv.appendChild(loadButton);
                actionsDiv.appendChild(deleteButton);
                item.appendChild(nameSpan);
                item.appendChild(actionsDiv);
                savedConfigsListEl.appendChild(item);
            });

        } catch (e) {
            console.error("Error loading configs from localStorage:", e);
            savedConfigsListEl.innerHTML = '<p class="empty-state">خطا در بارگذاری کانفیگ‌های ذخیره شده. ممکن است اطلاعات ذخیره شده قبلی خراب باشد.</p>';
            // Consider clearing corrupted data: localStorage.removeItem('notepadVPN_SingBoxConfigs_v1.1');
        }
    }
});

// Tab functionality - Ensure this is correctly defined and globally accessible if not inside DOMContentLoaded
function openTab(event, tabName, forceOpen = false) {
    let i, tabcontent, tabbuttons;
    
    // Hide all tab content
    tabcontent = document.getElementsByClassName("tab-content");
    for (i = 0; i < tabcontent.length; i++) {
        tabcontent[i].classList.remove("active"); // Use class for display none/block
    }
    
    // Deactivate all tab buttons
    tabbuttons = document.getElementsByClassName("tab-button");
    for (i = 0; i < tabbuttons.length; i++) {
        tabbuttons[i].classList.remove("active");
    }
    
    // Show the current tab's content
    const activeTabContent = document.getElementById(tabName);
    if (activeTabContent) {
        activeTabContent.classList.add("active");
    }

    // Activate the current tab's button
    if (event && event.currentTarget && !forceOpen) { 
      // If the function was called by a click event on a button
      event.currentTarget.classList.add("active");
    } else { 
        // If called programmatically (e.g., forceOpen or initial load)
        // Find the button that corresponds to tabName and activate it
        for (i = 0; i < tabbuttons.length; i++) {
            if (tabbuttons[i].getAttribute('onclick') && tabbuttons[i].getAttribute('onclick').includes(`'${tabName}'`)) {
                tabbuttons[i].classList.add("active");
                break; // Found and activated the button
            }
        }
    }
}
