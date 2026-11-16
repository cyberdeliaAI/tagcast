"""Combined response shapes, without assuming a particular live service grouping rule."""
from copy import deepcopy

import pytest
from test_library import change, raw

from tagcast.library import ConflictError, Library, LibraryError, plan_save, verify, write_requests


def combined(rows=False, flag=True, numbered=False):
    data = raw()
    data['combine_sets'] = flag
    data['library']['tracks']['101'][1] = 91
    if numbered:
        data['library']['tracks']['100'][5] = '1-01'
        data['library']['tracks']['101'][5] = '2-01'
    if rows:
        data['library']['albums']['91'] = ['Original', 4, [101], 1982, 2]
    return data


@pytest.mark.parametrize('rows', [False, True])
@pytest.mark.parametrize('numbered', [False, True])
def test_second_disc_track_changes_target_track_and_verify_original_membership(rows, numbered):
    data = combined(rows, numbered=numbered)
    library = Library(data)
    assert library.active_track_album(101) == 10
    assert 91 not in library.album_ids()
    assert library.combined_view and library.album_writes_blocked
    edit = change('track', 101, 10, title=('Song Two', 'Correct title'))
    edit.update(sourceAlbumId='91', libraryView={'combine_sets': True, 'combined_view': True})
    plan = plan_save(library, [edit])
    assert write_requests(plan, {}) == [('update_track', {'tracks': [{'file_id': 101, 'title': 'Correct title'}]})]
    data['library']['tracks']['101'][0] = 'Correct title'
    assert verify(Library(data), plan, {})[0]['status'] == 'saved'
    data['library']['tracks']['101'][1] = 92
    assert verify(Library(data), plan, {})[0]['status'] == 'unverified'


def test_combined_positions_preserve_disc_and_number_and_do_not_match_other_disc():
    library = Library(combined(numbered=True))
    tracks = library.album_view(10)['tracks']
    assert [(t['disc'], t['display_track'], t['album_id']) for t in tracks] == [(1, 1, '10'), (2, 1, '91')]
    assert library.album_summary(10)['repeated_numbers'] == 0
    assert library.track_view(101)['disc'] == 2
    assert Library(combined()).track_view(101)['disc'] == 0  # Unknown is not inferred from ID/order.


def test_track_number_edits_stay_blocked_in_both_combined_shapes():
    for data in (combined(), combined(flag=False), {**raw(), 'combine_sets': True}):
        library = Library(data)
        with pytest.raises(LibraryError, match='before changing track numbers'):
            plan_save(library, [change('track', 101, 10, track=(2, 4))])


def test_review_rejects_changed_source_setting_and_shape():
    data = combined()
    edit = change('track', 101, 10, title=('Song Two', 'Correct title'))
    edit.update(sourceAlbumId='91', libraryView={'combine_sets': True, 'combined_view': True})
    for modified in (combined(flag=False), raw(), combined()):
        if modified == data:
            modified['library']['tracks']['101'][1] = 92
        with pytest.raises(ConflictError):
            plan_save(Library(modified), [edit])
    plan = plan_save(Library(data), [edit])
    after = deepcopy(data)
    after['library']['tracks']['101'][0] = 'Correct title'
    after['combine_sets'] = False
    assert verify(Library(after), plan, {})[0]['status'] == 'unverified'


def test_ambiguous_or_missing_membership_never_selects_an_arbitrary_container():
    data = combined()
    data['library']['albums']['12'][2].append(101)
    with pytest.raises(LibraryError, match='ambiguous album membership'):
        plan_save(Library(data), [change('track', 101, 10, title=('Song Two', 'Correct title'))])
    data['library']['albums']['10'][2].remove(101)
    data['library']['albums']['12'][2].remove(101)
    with pytest.raises(LibraryError, match='no longer available'):
        plan_save(Library(data), [change('track', 101, 10, title=('Song Two', 'Correct title'))])


def test_original_disc_identity_and_view_survive_cache_round_trip():
    library = Library(combined(numbered=True))
    cached = Library(library.to_cache())
    assert cached.combined_view
    assert cached.track_view(101) == library.track_view(101)
    assert cached.albums.get(91) is None
    assert cached.track_view(101)['album_id'] == '91'


def test_missing_source_rows_do_not_expand_editing_beyond_one_album_artist():
    with pytest.raises(LibraryError, match='one album or one album artist'):
        plan_save(Library(combined()), [change('track', 101, 10, title=('Song Two', 'Correct title')),
                                      change('track', 102, 11, title=('Elsewhere', 'Other title'))])


def numeric_combined(flag=True):
    """Sanitized structure observed in the supplied combined library export.

    No private export IDs, titles, account data or library contents are copied.
    """
    data = raw()
    data['combine_sets'] = flag
    data['library']['albums']['10'][2] = [100, 101, 105, 106]
    data['library']['tracks']['100'][5] = 101
    data['library']['tracks']['101'][5] = 102
    for item_id, position in ((105, 201), (106, 202)):
        data['library']['tracks'][str(item_id)] = [
            'Synthetic second disc track', 10, 4, 1982, '', position, False, 0]
    return data


def test_numeric_combined_view_keeps_raw_numbers_and_received_ids():
    library = Library(numeric_combined())
    assert library.combined_view
    tracks = library.album_view(10)['tracks']
    assert [(t['track'], t['disc'], t['display_track']) for t in tracks] == [
        (101, 1, 1), (102, 1, 2), (201, 2, 1), (202, 2, 2)]
    assert {t['album_id'] for t in tracks} == {'10'}
    assert all(t['encoded_disc'] for t in tracks)
    summary = library.album_summary(10)
    assert summary['track_gaps'] == summary['duplicates'] == summary['repeated_numbers'] == 0
    assert library.tracks[105]['track'] == 201
    assert Library(library.to_cache()).track_view(105) == library.track_view(105)


def test_numeric_combined_title_review_never_sends_or_rewrites_track_number():
    data = numeric_combined()
    edit = change('track', 105, 10, title=('Synthetic second disc track', 'Correct title'))
    edit.update(sourceAlbumId='10', sourceTrack=201,
                libraryView={'combine_sets': True, 'combined_view': True})
    plan = plan_save(Library(data), [edit])
    assert write_requests(plan, {}) == [('update_track', {'tracks': [{'file_id': 105, 'title': 'Correct title'}]})]
    data['library']['tracks']['105'][0] = 'Correct title'
    assert verify(Library(data), plan, {})[0]['status'] == 'saved'
    data['library']['tracks']['105'][5] = 203
    assert verify(Library(data), plan, {})[0]['status'] == 'unverified'
    with pytest.raises(ConflictError, match='stored position changed'):
        plan_save(Library(data), [edit])


def test_flag_off_numbers_are_not_decoded_but_transitional_combined_shape_is_guarded():
    library = Library(numeric_combined(flag=False))
    assert library.combined_view and library.album_writes_blocked
    assert library.track_view(105)['track'] == library.track_view(105)['display_track'] == 201
    assert not library.track_view(105)['encoded_disc']


def test_single_or_ambiguous_hundred_numbers_are_not_assumed_to_be_disc_encoding():
    for values in ((101, 102), (1, 101, 201), (101, 203), (101, 0, 201), (101, 301)):
        for flag in (True, False):
            data = raw()
            data['combine_sets'] = flag
            data['library']['albums']['10'][2] = []
            for i, value in enumerate(values, 200):
                data['library']['albums']['10'][2].append(i)
                data['library']['tracks'][str(i)] = ['Synthetic', 10, 4, 1982, '', value, False, 0]
            library = Library(data)
            assert not library.combined_view
            assert [library.track_view(i)['display_track'] for i in range(200, 200 + len(values))] == list(values)


def test_combined_track_with_unknown_native_number_can_still_edit_its_title():
    data = combined()
    data['library']['tracks']['101'][5] = None
    edit = change('track', 101, 10, title=('Song Two', 'Correct title'))
    edit.update(sourceAlbumId='91', sourceTrack=None,
                libraryView={'combine_sets': True, 'combined_view': True})
    plan = plan_save(Library(data), [edit])
    assert write_requests(plan, {}) == [('update_track', {'tracks': [{'file_id': 101, 'title': 'Correct title'}]})]
    data['library']['tracks']['101'][0] = 'Correct title'
    assert verify(Library(data), plan, {})[0]['status'] == 'saved'


def test_explicit_disc_track_strings_sort_by_display_position_without_changing_raw_values():
    data = combined(numbered=True)
    data['library']['tracks']['105'] = ['Alphabetically first', 91, 4, 1982, '', '2-02', False, 0]
    data['library']['tracks']['101'][0] = 'Zulu first track'
    data['library']['albums']['10'][2].append(105)
    tracks = Library(data).album_view(10)['tracks']
    assert [t['id'] for t in tracks] == ['100', '101', '105']
    assert [t['display_track'] for t in tracks] == [1, 1, 2]
    assert tracks[-1]['native_track'] == '2-02'
