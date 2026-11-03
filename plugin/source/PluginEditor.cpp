#include "PluginEditor.h"

#include "Theme.h"

namespace {

void styleLabel(juce::Label& l, const juce::String& text, float size = 12.0f, juce::Colour c = theme::dim) {
    l.setText(text, juce::dontSendNotification);
    l.setFont(juce::FontOptions(size));
    l.setColour(juce::Label::textColourId, c);
    l.setJustificationType(juce::Justification::centredLeft);
}

} // namespace

MkwavezEditor::MkwavezEditor(MkwavezProcessor& p) : AudioProcessorEditor(&p), proc(p), view(p) {
    lnf.setColourScheme({theme::bg, theme::panel, theme::panel, theme::border, theme::text, theme::accent, theme::bg, theme::accentBg,
                         theme::text});
    lnf.setColour(juce::Slider::rotarySliderFillColourId, theme::accent);
    lnf.setColour(juce::Slider::thumbColourId, theme::accent);
    lnf.setColour(juce::Slider::trackColourId, theme::accentBg);
    lnf.setColour(juce::Slider::textBoxOutlineColourId, juce::Colours::transparentBlack);
    setLookAndFeel(&lnf);

    auto& s = proc.parameters();
    styleLabel(title, "mkwavez", 18.0f, theme::text);
    addAndMakeVisible(title);

    for (auto* b : {&play, &hostSync, &omni}) addAndMakeVisible(*b);
    playAtt = std::make_unique<ButtonAttachment>(s, params::play, play);
    syncAtt = std::make_unique<ButtonAttachment>(s, params::hostSync, hostSync);
    omniAtt = std::make_unique<ButtonAttachment>(s, params::omni, omni);

    styleLabel(bpmLabel, "BPM");
    styleLabel(midiLabel, "MIDI voice");
    styleLabel(gainLabel, "Gain");
    styleLabel(stepLabel, "");
    for (auto* l : {&bpmLabel, &midiLabel, &gainLabel, &stepLabel}) addAndMakeVisible(*l);
    for (auto* sl : {&bpm, &midiVoice, &gain}) {
        sl->setTextBoxStyle(juce::Slider::TextBoxLeft, false, 56, 22);
        addAndMakeVisible(*sl);
    }
    bpmAtt = std::make_unique<SliderAttachment>(s, params::bpm, bpm);
    midiAtt = std::make_unique<SliderAttachment>(s, params::midiVoice, midiVoice);
    gainAtt = std::make_unique<SliderAttachment>(s, params::gain, gain);

    for (int i = 0; i < params::VOICE_SLOTS; ++i) {
        auto& t = tabs[(size_t) i];
        t.setButtonText("V" + juce::String(i + 1));
        t.setClickingTogglesState(true);
        t.setRadioGroupId(1);
        t.setColour(juce::TextButton::buttonOnColourId, theme::voice(i + 1).withAlpha(0.35f));
        t.onClick = [this, i] { selectVoice(i); };
        addAndMakeVisible(t);
    }
    addAndMakeVisible(view);

    for (int f = 0; f < params::VOICE_FIELD_COUNT; ++f) {
        if (f == params::mute) continue;
        auto& k = knobs[(size_t) f];
        k.slider.setTextBoxStyle(juce::Slider::TextBoxBelow, false, 72, 18);
        styleLabel(k.label, params::voiceLabel((params::VoiceField) f), 12.0f);
        k.label.setJustificationType(juce::Justification::centred);
        addAndMakeVisible(k.slider);
        addAndMakeVisible(k.label);
    }
    addAndMakeVisible(mute);

    reset.onClick = [this] {
        juce::NativeMessageBox::showOkCancelBox(juce::MessageBoxIconType::QuestionIcon, "Reset project",
                                                "Replace the tables, wavetables, voices and sequences with the start state?", this,
                                                juce::ModalCallbackFunction::create([this](int ok) {
                                                    if (ok) proc.resetDocument();
                                                }));
    };
    addAndMakeVisible(reset);
    styleLabel(footer, "Native preview: playback, MIDI and host automation. Generate / Timeline / Wavetables editing comes with the hosted web UI.");
    addAndMakeVisible(footer);

    tabs[0].setToggleState(true, juce::dontSendNotification);
    selectVoice(0);
    setResizable(true, true);
    setResizeLimits(720, 480, 1600, 1100);
    setSize(900, 580);
    startTimerHz(30);
}

MkwavezEditor::~MkwavezEditor() {
    stopTimer();
    setLookAndFeel(nullptr);
}

void MkwavezEditor::selectVoice(int newSlot) {
    slot = newSlot;
    auto& s = proc.parameters();
    for (int f = 0; f < params::VOICE_FIELD_COUNT; ++f) {
        if (f == params::mute) continue;
        auto& k = knobs[(size_t) f];
        k.attachment.reset();
        k.attachment = std::make_unique<SliderAttachment>(s, params::voiceId(slot, (params::VoiceField) f), k.slider);
        k.slider.setColour(juce::Slider::rotarySliderFillColourId, theme::voice(slot + 1));
        k.slider.setColour(juce::Slider::thumbColourId, theme::voice(slot + 1));
    }
    muteAtt.reset();
    muteAtt = std::make_unique<ButtonAttachment>(s, params::voiceId(slot, params::mute), mute);
    view.setVoice(slot + 1);
}

void MkwavezEditor::timerCallback() {
    const auto& st = proc.liveStatus();
    stepLabel.setText(st.playing.load() ? "step " + juce::String(st.step.load() + 1) : "stopped", juce::dontSendNotification);
    view.repaint();
}

void MkwavezEditor::paint(juce::Graphics& g) { g.fillAll(theme::bg); }

void MkwavezEditor::resized() {
    auto r = getLocalBounds().reduced(10);
    auto top = r.removeFromTop(30);
    title.setBounds(top.removeFromLeft(100));
    // Right side first so it never gets squeezed out.
    stepLabel.setBounds(top.removeFromRight(64));
    gain.setBounds(top.removeFromRight(96).reduced(0, 3));
    gainLabel.setBounds(top.removeFromRight(34));
    top.removeFromRight(8);
    play.setBounds(top.removeFromLeft(64));
    hostSync.setBounds(top.removeFromLeft(96));
    bpmLabel.setBounds(top.removeFromLeft(32));
    bpm.setBounds(top.removeFromLeft(100).reduced(0, 3));
    top.removeFromLeft(10);
    omni.setBounds(top.removeFromLeft(64));
    midiLabel.setBounds(top.removeFromLeft(66));
    midiVoice.setBounds(top.removeFromLeft(96).reduced(0, 3));

    r.removeFromTop(8);
    auto bottom = r.removeFromBottom(26);
    reset.setBounds(bottom.removeFromRight(120));
    footer.setBounds(bottom);
    r.removeFromBottom(6);

    auto tabRow = r.removeFromTop(28);
    for (auto& t : tabs) t.setBounds(tabRow.removeFromLeft(56).reduced(2, 0));
    mute.setBounds(tabRow.removeFromLeft(80).withTrimmedLeft(12));
    r.removeFromTop(6);

    view.setBounds(r.removeFromTop(juce::jmax(140, r.getHeight() - 250)));
    r.removeFromTop(8);

    // Two rows of six knobs: X axis + level / octave, then Y axis + envelope.
    const params::VoiceField rows[2][6] = {
        {params::position, params::lfoDepth, params::lfoRate, params::octave, params::level, params::attack},
        {params::positionY, params::lfoDepthY, params::lfoRateY, params::decay, params::sustain, params::release}};
    const int rowH = r.getHeight() / 2;
    for (const auto& row : rows) {
        auto line = r.removeFromTop(rowH);
        const int w = line.getWidth() / 6;
        for (auto f : row) {
            auto cell = line.removeFromLeft(w).reduced(4, 0);
            knobs[(size_t) f].label.setBounds(cell.removeFromTop(16));
            knobs[(size_t) f].slider.setBounds(cell);
        }
    }
}
