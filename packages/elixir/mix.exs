defmodule CodexSdk.MixProject do
  use Mix.Project

  def project do
    [
      app: :usetemi_codex_sdk,
      version: "0.131.0",
      elixir: "~> 1.19",
      aliases: aliases(),
      description: description(),
      package: package(),
      name: "CodexSdk",
      source_url: "https://github.com/usetemi/codex-sdk",
      homepage_url: "https://github.com/usetemi/codex-sdk",
      start_permanent: Mix.env() == :prod,
      deps: deps()
    ]
  end

  def application do
    [
      extra_applications: [:logger]
    ]
  end

  defp deps do
    [
      {:jason, "~> 1.4"},
      {:credo, "~> 1.7", only: [:dev, :test], runtime: false},
      {:ex_dna, "~> 1.5", only: [:dev, :test], runtime: false},
      {:ex_slop, "~> 0.4.1", only: [:dev, :test], runtime: false}
    ]
  end

  defp aliases do
    [
      static: [
        "format --check-formatted",
        "compile --force --warnings-as-errors",
        "credo --strict",
        "ex_dna"
      ]
    ]
  end

  defp description do
    "Temi convenience SDK and low-level transport helpers for Codex."
  end

  defp package do
    [
      files: ~w(lib .formatter.exs mix.exs README.md LICENSE),
      licenses: ["MIT"],
      links: %{"GitHub" => "https://github.com/usetemi/codex-sdk"}
    ]
  end
end
