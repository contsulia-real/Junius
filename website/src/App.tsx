import { useMemo, useState } from 'react'
import { IconBrandGithub, IconCheck, IconCopy } from '@tabler/icons-react'
import { ThemeProvider, createThemeFromColorSeed } from '@contsulia/weave'
import { AppBar } from '@contsulia/weave/components/AppBar'
import { Button } from '@contsulia/weave/components/Button'
import { Card } from '@contsulia/weave/components/Card'
import { Code } from '@contsulia/weave/components/Code'
import { Column } from '@contsulia/weave/components/Column'
import { Divider } from '@contsulia/weave/components/Divider'
import { Grid } from '@contsulia/weave/components/Grid'
import { Image } from '@contsulia/weave/components/Image'
import { Link } from '@contsulia/weave/components/Link'
import { Row } from '@contsulia/weave/components/Row'
import { Text } from '@contsulia/weave/components/Text'
import { Icon } from '@contsulia/weave/components/Icon'

const GITHUB_URL = 'https://github.com/contsulia-real/Junius'
const OPENAI_TUNNEL_DOC_URL = 'https://developers.openai.com/api/docs/guides/secure-mcp-tunnels'
const MCP_URL = 'http://127.0.0.1:8787/mcp'
const ICON_URL = `${import.meta.env.BASE_URL}icon.svg`
const INSTALL_COMMAND =
  'irm https://raw.githubusercontent.com/contsulia-real/Junius/main/install.ps1 | iex'

const capabilities = [
  {
    title: 'Files and repositories',
    description:
      'Read, search, edit, and organize Workspace files, then inspect and change the Git repository around them.',
    detail: 'Workspace · search · edits · Git',
  },
  {
    title: 'Processes and Jobs',
    description:
      'Run local commands and keep long-running work alive as persistent Jobs instead of losing execution state between turns.',
    detail: 'commands · processes · persistent Jobs',
  },
  {
    title: 'Browser and desktop',
    description:
      'Use browser automation and Windows desktop control from Chat when you explicitly authorize those capabilities.',
    detail: 'browser automation · Windows desktop',
  },
  {
    title: 'Skills and observability',
    description:
      'Use local Agent Skills and inspect turns, tool calls, Skill usage, and execution events in the native Junius panel.',
    detail: 'Agent Skills · turns · tools · events',
  },
] as const

const prompts = [
  'Fix the failing tests in this repo, run them again, and commit the verified change.',
  'Open the site, reproduce this browser bug, patch it locally, and verify the fix.',
  'Keep this job running, inspect the logs, and tell me what changed since the last turn.',
] as const

const observability = [
  ['Turn lifecycle', 'See the work grouped by the actual ChatGPT turn that triggered it.'],
  ['Tool calls', 'Inspect which local operation ran instead of guessing from the final answer.'],
  ['Skill usage', 'See when a local Agent Skill participates in the execution path.'],
  ['Event log', 'Follow the execution events that connect the conversation to the local runtime.'],
] as const

function App() {
  const theme = useMemo(() => createThemeFromColorSeed('#ff4fa3'), [])
  const [copied, setCopied] = useState(false)

  const copyInstallCommand = async () => {
    await navigator.clipboard.writeText(INSTALL_COMMAND)
    setCopied(true)
  }

  return (
    <ThemeProvider theme={theme} mode="system">

      <Column width='100vw' height='100vh'>
            <AppBar
          elevated
          sticky
          mode='floating'
          size="small"
          title={<Text>Junius</Text>}
          leading={<Image viewProps={{width: '24px'}} src={ICON_URL} alt="Junius" />}
          trailing={
              <Link
                href={GITHUB_URL}
                text={<Row gap={0.5} align='center'><Icon icon={IconBrandGithub}></Icon><Text>Github</Text></Row>}
                target="_blank"
                hideUnderline
                hideIcon
                viewProps={{"aria-label": "GitHub"}}
              />
          }
        />

      <Column overflow="auto">
        <Column role="main" width="fill">
          <Column
            width="fill"
          >
            <Grid
              columns={1}
              md={{ columns: 2 }}
              gap={5}
              width="fill"
              maxWidth={76}
              marginX="auto"
              paddingX={1.5}
              paddingY={7}
              align="center"
            >
              <Column gap={2} maxWidth={40}>
                <Image
                  src={ICON_URL}
                  alt="Junius"
                  fit="contain"
                  viewProps={{
                    width: 5,
                    height: 5,
                  }}
                />

                <Text typo="display-medium" wrap="balance">
                  Keep working in ChatGPT Chat after Work runs out.
                </Text>

                <Text
                  typo="body-large"
                  color="secondary"
                  wrap="balance"
                  viewProps={{ maxWidth: 38 }}
                >
                  Junius gives ChatGPT Chat local execution on your Windows
                  machine through MCP. The conversation keeps the context;
                  Junius keeps it connected to the machine where the real work
                  lives.
                </Text>

                <Grid columns={3} gap={1.5} width="fill">
                  <Column gap={0.25}>
                    <Text typo="label-large">Local</Text>
                    <Text typo="body-small" color="secondary">
                      Runs on your PC
                    </Text>
                  </Column>
                  <Column gap={0.25}>
                    <Text typo="label-large">Open source</Text>
                    <Text typo="body-small" color="secondary">
                      User-owned
                    </Text>
                  </Column>
                  <Column gap={0.25}>
                    <Text typo="label-large">Windows</Text>
                    <Text typo="body-small" color="secondary">
                      Alpha
                    </Text>
                  </Column>
                </Grid>

                <Link
                  href={GITHUB_URL}
                  text="View source on GitHub"
                  target="_blank"
                  viewProps={{width: 'content'}}
                />
              </Column>

              <Card
                viewProps={{
                  padding: 2,
                  radius: 'large',
                  minWidth: 0,
                  background: 'surface',
                }}
              >
                <Column gap={1.5}>
                  <Column gap={0.4}>
                    <Text typo="headline-small">Install Junius</Text>
                    <Text typo="body-medium" color="secondary">
                      One PowerShell command. Installs for the current Windows
                      user and starts the local runtime immediately.
                    </Text>
                  </Column>

                  <Code
                    language="powershell"
                    viewProps={{
                      width: 'fill',
                      overflow: 'auto',
                      scrollbar: { outside: true },
                    }}
                  >
                    {INSTALL_COMMAND}
                  </Code>

                  <Row gap={1} wrap align="center">
                    <Button
                      text={copied ? 'Copied' : 'Copy install command'}
                      icon={copied ? IconCheck : IconCopy}
                      variant="primary"
                      size="large"
                      viewProps={{ onClick: copyInstallCommand }}
                    />
                    <Text typo="body-small" color="secondary">
                      No administrator elevation required.
                    </Text>
                  </Row>

                  <Divider />

                  <Grid columns={1} sm={{ columns: 3 }} gap={1.5}>
                    <Column gap={0.3}>
                      <Text typo="label-large">1 · Install</Text>
                      <Text typo="body-small" color="secondary">
                        Node.js 20+ and Python 3.10+
                      </Text>
                    </Column>
                    <Column gap={0.3}>
                      <Text typo="label-large">2 · Tunnel</Text>
                      <Text typo="body-small" color="secondary">
                        Bridge only the local /mcp endpoint
                      </Text>
                    </Column>
                    <Column gap={0.3}>
                      <Text typo="label-large">3 · Connect ChatGPT</Text>
                      <Text typo="body-small" color="secondary">
                        Create your personal MCP/plugin connection
                      </Text>
                    </Column>
                  </Grid>
                </Column>
              </Card>
            </Grid>
          </Column>

          <Column
            id="connect"
            width="fill"
            background="surfaceHover"
          >
            <Column
              width="fill"
              maxWidth={76}
              marginX="auto"
              paddingX={1.5}
              paddingY={6}
              gap={3}
            >
              <Grid columns={1} md={{ columns: 2 }} gap={5}>
                <Column gap={1}>
                  <Text typo="display-small" wrap="balance">
                    Connect ChatGPT without making Junius public.
                  </Text>
                  <Text typo="body-large" color="secondary" wrap="balance">
                    Junius listens only on your own machine. ChatGPT cannot
                    reach that loopback server directly, so the supported path
                    is OpenAI Secure MCP Tunnel. The tunnel client connects
                    outward to OpenAI and forwards MCP requests back to the
                    exact local Junius endpoint.
                  </Text>
                  <Text typo="body-medium" color="secondary" wrap="balance">
                    The installer does not create the tunnel or store your
                    OpenAI tunnel ID, runtime API key, or ChatGPT workspace
                    credentials. Those remain user-managed OpenAI resources.
                    The OpenAI account also needs the tunnel permissions and
                    ChatGPT developer-mode access required to create and use
                    the connection.
                  </Text>
                  <Row gap={1.25} wrap>
                    <Link
                      href={OPENAI_TUNNEL_DOC_URL}
                      text="Open Secure MCP Tunnel docs"
                      target="_blank"
                    />
                    <Link
                      href={GITHUB_URL}
                      text="Read the full Junius setup"
                      target="_blank"
                    />
                  </Row>
                </Column>

                <Card
                  viewProps={{
                    padding: 2,
                    radius: 'large',
                    background: 'surface',
                  }}
                >
                  <Column gap={1.5}>
                    <Column gap={0.4}>
                      <Text typo="title-large">1 · Point the tunnel at Junius</Text>
                      <Text typo="body-medium" color="secondary">
                        Create or select a tunnel in OpenAI Platform, install
                        tunnel-client on this Windows PC, and configure its
                        HTTP MCP target to the exact URL below.
                      </Text>
                    </Column>

                    <Code
                      language="powershell"
                      viewProps={{
                        width: 'fill',
                        overflow: 'auto',
                        scrollbar: { outside: true },
                      }}
                    >
                      {MCP_URL}
                    </Code>

                    <Text typo="body-small" color="secondary">
                      Do not use the bare http://127.0.0.1:8787 origin. Junius
                      keeps its local diagnostics outside the tunneled MCP
                      surface.
                    </Text>

                    <Divider />

                    <Column gap={0.4}>
                      <Text typo="title-large">2 · Verify the tunnel</Text>
                      <Text typo="body-medium" color="secondary">
                        Run tunnel-client doctor for the profile, then keep
                        tunnel-client run healthy while you use Junius.
                      </Text>
                    </Column>

                    <Divider />

                    <Column gap={0.4}>
                      <Text typo="title-large">3 · Add Junius in ChatGPT</Text>
                      <Text typo="body-medium" color="secondary">
                        In ChatGPT Plugins, choose the plus button and create a
                        custom MCP server. Under Connection choose Tunnel,
                        select the matching Secure MCP Tunnel, review the
                        discovered Junius tools, and create the personal
                        plugin connection.
                      </Text>
                    </Column>
                  </Column>
                </Card>
              </Grid>

              <Grid columns={1} md={{ columns: 3 }} gap={1.25}>
                <Card viewProps={{ padding: 1.5, radius: 'large' }}>
                  <Column gap={0.5}>
                    <Text typo="title-medium">Local Junius</Text>
                    <Text typo="body-small" color="secondary">
                      127.0.0.1:8787/mcp stays on your Windows machine.
                    </Text>
                  </Column>
                </Card>
                <Card viewProps={{ padding: 1.5, radius: 'large' }}>
                  <Column gap={0.5}>
                    <Text typo="title-medium">Secure MCP Tunnel</Text>
                    <Text typo="body-small" color="secondary">
                      Outbound HTTPS transport to the OpenAI-managed tunnel.
                    </Text>
                  </Column>
                </Card>
                <Card viewProps={{ padding: 1.5, radius: 'large' }}>
                  <Column gap={0.5}>
                    <Text typo="title-medium">ChatGPT</Text>
                    <Text typo="body-small" color="secondary">
                      Your personal developer-mode MCP/plugin connection.
                    </Text>
                  </Column>
                </Card>
              </Grid>
            </Column>
          </Column>

          <Column
            width="fill"
            maxWidth={76}
            marginX="auto"
            paddingX={1.5}
          >
            <Grid
              columns={1}
              md={{ columns: 3 }}
              gap={0}
              paddingY={4}
              width={'fill'}
            >
              <Column padding={1.5} gap={0.5}>
                <Text typo="title-large">Work usage can end.</Text>
                <Text typo="body-medium" color="secondary">
                  The project often has not.
                </Text>
              </Column>

              <Column
                padding={1.5}
                gap={0.5}
                borderLeft={0.0625}
                borderLeftColor="outline"
              >
                <Text typo="title-large">The Chat can stay.</Text>
                <Text typo="body-medium" color="secondary">
                  Context and reasoning remain in the same conversation.
                </Text>
              </Column>

              <Column
                padding={1.5}
                gap={0.5}
                borderLeft={0.0625}
                borderLeftColor="outline"
              >
                <Text typo="title-large">Execution continues locally.</Text>
                <Text typo="body-medium" color="secondary">
                  Junius keeps the Windows machine available to Chat.
                </Text>
              </Column>
            </Grid>

          </Column>

          <Column
            id="capabilities"
            maxWidth={76}
            marginX="auto"
            paddingX={1.5}
            paddingY={6}
            gap={3}
          >
            <Grid columns={1} md={{ columns: 2 }} gap={4} align="end">
              <Column gap={0.75}>
                <Text typo="display-small" wrap="balance">
                  Real local work, not another chat wrapper.
                </Text>
              </Column>
              <Text typo="body-large" color="secondary" wrap="balance">
                Junius is the execution layer between the conversation and the
                Windows environment you are already using.
              </Text>
            </Grid>

            <Grid columns={1} md={{ columns: 2 }} gap={1.25}>
              {capabilities.map((capability) => (
                <Card
                  key={capability.title}
                  viewProps={{
                    padding: 2,
                    radius: 'large',
                    minHeight: 14,
                    transition: {
                      properties: ['transform', 'background'],
                      duration: 'fast',
                    },
                    hover: {
                      background: 'surfaceHover',
                      translateY: -0.15,
                    },
                  }}
                >
                  <Column height="fill" gap={1} justify="space-between">
                    <Column gap={0.65}>
                      <Text typo="headline-small">{capability.title}</Text>
                      <Text typo="body-medium" color="secondary" wrap="balance">
                        {capability.description}
                      </Text>
                    </Column>
                    <Text typo="body-small" color="primary">
                      {capability.detail}
                    </Text>
                  </Column>
                </Card>
              ))}
            </Grid>
          </Column>

          <Column background="surfaceHover">
            <Grid
              columns={1}
              md={{ columns: 2 }}
              gap={5}
              width="fill"
              maxWidth={76}
              marginX="auto"
              paddingX={1.5}
              paddingY={6}
            >
              <Column gap={1.25}>
                <Text typo="display-small" wrap="balance">
                  Ask Chat to do the work, not just describe it.
                </Text>
                <Text typo="body-large" color="secondary" wrap="balance">
                  The useful unit is the complete action you wanted done on the
                  machine.
                </Text>
              </Column>

              <Column gap={1}>
                {prompts.map((prompt, index) => (
                  <Card
                    key={prompt}
                    viewProps={{
                      padding: 1.5,
                      radius: 'large',
                      background: index === 0 ? 'surface' : 'surfaceHover',
                    }}
                  >
                    <Row gap={1.25} align="start">
                      <Text typo="title-large" color="primary">
                        {String(index + 1).padStart(2, '0')}
                      </Text>
                      <Text typo="title-medium" wrap="balance">
                        “{prompt}”
                      </Text>
                    </Row>
                  </Card>
                ))}
              </Column>
            </Grid>
          </Column>

          <Column
            id="observability"
            width="fill"
            maxWidth={76}
            marginX="auto"
            paddingX={1.5}
            paddingY={6}
            gap={3}
          >
            <Grid columns={1} md={{ columns: 2 }} gap={5}>
              <Column gap={1}>
                <Text typo="display-small" wrap="balance">
                  See what Junius is actually doing.
                </Text>
                <Text typo="body-large" color="secondary" wrap="balance">
                  Junius includes native observability inside ChatGPT, so the
                  local execution path is visible instead of hidden behind a
                  generic “working” state.
                </Text>
                <Text typo="body-medium">
                  ChatGPT decides. Junius executes locally.
                </Text>
              </Column>

              <Card
                viewProps={{
                  padding: 1.75,
                  radius: 'large',
                  background: 'surfaceHover',
                }}
              >
                <Column gap={0}>
                  {observability.map(([title, description], index) => (
                    <Column key={title}>
                      <Grid
                        columns={1}
                        sm={{ columns: 2 }}
                        gap={1.5}
                        paddingY={1.35}
                      >
                        <Text typo="title-medium">{title}</Text>
                        <Text typo="body-small" color="secondary">
                          {description}
                        </Text>
                      </Grid>
                      {index < observability.length - 1 ? <Divider /> : null}
                    </Column>
                  ))}
                </Column>
              </Card>
            </Grid>
          </Column>

          <Column
            width="fill"
            background="surfaceHover"
          >
            <Grid
              columns={1}
              md={{ columns: 2 }}
              gap={5}
              width="fill"
              maxWidth={76}
              marginX="auto"
              paddingX={1.5}
              paddingY={6}
              align="center"
            >
              <Column gap={1}>
                <Text typo="display-small" wrap="balance">
                  One local runtime. Your existing ChatGPT workflow.
                </Text>
                <Text typo="body-large" color="secondary" wrap="balance">
                  No second agent UI. No separate cloud workspace. Install
                  Junius, bridge its local /mcp endpoint through your own OpenAI
                  Secure MCP Tunnel, create the personal ChatGPT connection,
                  and keep the work moving from Chat.
                </Text>
              </Column>

              <Row gap={1.25} wrap justify="end">
                <Button
                  text={copied ? 'Install command copied' : 'Copy install command'}
                  icon={copied ? IconCheck : IconCopy}
                  variant="primary"
                  size="large"
                  viewProps={{ onClick: copyInstallCommand }}
                />
                <Link
                  href={GITHUB_URL}
                  text="Read setup on GitHub"
                  target="_blank"
                />
              </Row>
            </Grid>
          </Column>
        </Column>

        <Row
          role="contentinfo"
          width="fill"
          maxWidth={76}
          marginX="auto"
          paddingX={1.5}
          paddingY={2.5}
          gap={1}
          justify="space-between"
          align="center"
          wrap
        >
          <Text typo="body-small" color="secondary">
            Junius — local execution for ChatGPT Chat on Windows.
          </Text>
          <Text typo="body-small" color="secondary">
            Free · Open source · User-owned · Community-funded
          </Text>
        </Row>
      </Column>
      </Column>
    </ThemeProvider>
  )
}

export default App
